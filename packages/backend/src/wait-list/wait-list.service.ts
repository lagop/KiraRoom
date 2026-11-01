import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'crypto';
import { PrismaService } from '../common/prisma/prisma.service';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';
import { realEmail } from '../common/placeholder-email';
import { SALON_MANAGERS } from '../auth/decorators/roles.decorator';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/services/email.service';
import { SmsService } from '../notifications/services/sms.service';
import { NotificationType } from '../notifications/dto';
import { salonPublicUrlFromEnv } from '../web-domain/public-url';
import { WhatsAppTemplateService } from '../whatsapp/whatsapp-template.service';
import { WAITLIST_SLOT_AVAILABLE, spanishDate } from '../whatsapp/whatsapp-templates';
import {
  NotifyWaitListDto,
  WaitListCreateDto,
  WaitListStatus,
  WaitListUpdateDto,
} from './wait-list.dto';

export type { WaitListStatus, WaitListCreateDto, WaitListUpdateDto } from './wait-list.dto';

type Channel = 'email' | 'whatsapp' | 'sms' | 'inApp';

export interface ChannelOutcome {
  channel: Channel;
  status: 'sent' | 'skipped' | 'failed';
  reason?: string;
}

export interface NotifyResult {
  /** True only when email, WhatsApp or SMS actually went out. */
  notified: boolean;
  channels: ChannelOutcome[];
  /** The link sent to book; null when the service is not bookable online (the notice says to call). */
  bookingUrl: string | null;
  /** One line for the panel, in Spanish. */
  summary: string;
}

/** Entries still waiting for a slot. `notified` ones stay eligible for later slots. */
export const ACTIVE_STATUSES: WaitListStatus[] = ['waiting', 'notified'];

/**
 * An open-ended entry (no "hasta") nobody has touched for this long --
 * no notice, no edit -- is stale: the client has most likely booked
 * elsewhere or forgotten. Counted from the later of its last change and its
 * "desde", so a request for months ahead is not cut short.
 */
export const WAIT_LIST_MAX_AGE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Why an entry was closed (WaitList.closedReason). */
export const CLOSED_REASONS = {
  /** Its "hasta" is in the past. */
  windowPassed: 'window_passed',
  /** Open-ended and untouched for WAIT_LIST_MAX_AGE_DAYS. */
  tooOld: 'too_old',
  /** The client pressed "Ya no me interesa" in a notice. */
  clientLeft: 'client_left',
} as const;
type ExpiryReason = typeof CLOSED_REASONS.windowPassed | typeof CLOSED_REASONS.tooOld;

function time(value: unknown): number {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string') return new Date(value).getTime();
  return NaN;
}

/**
 * Whether an open entry has gone stale, and why; null while it is still
 * good. `salonToday` is the salon's calendar day ("YYYY-MM-DD"). A row
 * without dates (none in the database) is never stale.
 */
export function staleReason(
  entry: { earliestDate?: Date | string | null; latestDate?: Date | string | null; updatedAt?: Date | string | null },
  salonToday: string,
  now: Date,
): ExpiryReason | null {
  const latest = time(entry.latestDate);
  if (Number.isFinite(latest)) {
    return new Date(latest).toISOString().slice(0, 10) < salonToday ? CLOSED_REASONS.windowPassed : null;
  }
  const touched = time(entry.updatedAt);
  if (!Number.isFinite(touched)) return null;
  const earliest = time(entry.earliestDate);
  const from = Number.isFinite(earliest) ? Math.max(touched, earliest) : touched;
  return now.getTime() - from > WAIT_LIST_MAX_AGE_DAYS * DAY_MS ? CLOSED_REASONS.tooOld : null;
}

const LEAVE_SIGNATURE_CHARS = 32;

function leaveSignature(payload: string, secret: string): string {
  // A key of its own, derived, so this signature is never valid anywhere else.
  const key = createHmac('sha256', secret).update('wait-list-leave:v1').digest();
  return createHmac('sha256', key).update(payload).digest('base64url').slice(0, LEAVE_SIGNATURE_CHARS);
}

/**
 * The token of an entry's "Ya no me interesa" link: the entry id, signed
 * (HMAC-SHA256, 192 bits kept), so it cannot be guessed or made for another
 * entry. It carries no personal data.
 */
export function waitListLeaveToken(entryId: string, secret: string): string {
  const payload = Buffer.from(`w.${entryId}`).toString('base64url');
  return `${payload}.${leaveSignature(payload, secret)}`;
}

/** The entry id a token names, or null when it is malformed or not ours. */
export function parseWaitListLeaveToken(token: string, secret: string): string | null {
  const [payload, signature, extra] = String(token ?? '').split('.');
  if (!payload || !signature || extra !== undefined || !secret) return null;
  const expected = Buffer.from(leaveSignature(payload, secret));
  const given = Buffer.from(signature);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  const decoded = Buffer.from(payload, 'base64url').toString();
  if (!decoded.startsWith('w.')) return null;
  const id = decoded.slice(2);
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

/** What the public "Ya no me interesa" page shows. */
export interface LeaveLinkInfo {
  salonName: string;
  serviceName: string;
  /** False once the entry is closed, whatever closed it. */
  waiting: boolean;
}

/** How many waiting clients an automatic notice reaches per freed slot. */
const AUTO_NOTIFY_MAX = 3;
/** How many entries an automatic notice tries, at most, to reach those three. */
const AUTO_NOTIFY_MAX_ATTEMPTS = 10;
/**
 * A client told about a slot is not told again automatically for this long:
 * several cancellations in one morning go to different people instead of
 * the same one three times.
 */
const AUTO_NOTIFY_COOLDOWN_MS = 12 * 60 * 60 * 1000;
/** Automatic notices only go out from 9:00 to 21:00, salon time. */
const QUIET_FROM_HOUR = 21;
const QUIET_UNTIL_HOUR = 9;
const NOTICE_TYPE = 'waitlist_slot_available';
const DEFAULT_TZ = 'Europe/Madrid';

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const WHATSAPP_REASONS: Record<string, string> = {
  not_connected: 'el salón no ha conectado su número de WhatsApp',
};

/**
 * A calendar day from "YYYY-MM-DD" (a full ISO date-time is cut to its day),
 * as midnight UTC like the rest of the app's dates. "2026-13-01" or
 * "2026-02-30" are refused with a 400 instead of failing later.
 */
export function parseDay(value: string, label: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value ?? ''));
  const d = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : null;
  if (!m || !d || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
    throw new BadRequestException(`${label}: la fecha no es válida`);
  }
  return d;
}

/** The salon's calendar day ("YYYY-MM-DD") and hour at `now`. */
export function salonClock(now: Date, timeZone: string): { day: string; hour: number } {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
    }).formatToParts(now);
  } catch {
    return salonClock(now, DEFAULT_TZ);
  }
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) % 24 };
}

export function isQuietHour(hour: number): boolean {
  return hour >= QUIET_FROM_HOUR || hour < QUIET_UNTIL_HOUR;
}

type ManagerNote = 'manual' | 'night' | 'unreachable';

/**
 * Wait-list for fully booked services, gated behind
 * `virtual_receptionist_advanced`.
 *
 * A notice really goes out through the salon's channels -- email, then the
 * salon's WhatsApp number (approved template) or SMS -- respecting what the
 * client opted out of, with a link to book the slot (or, for a service that
 * is not bookable online, asking the client to call the salon). The entry is
 * only marked `notified` when one of them delivered; otherwise the answer
 * says why nothing went (no provider configured, no phone, opted out...).
 *
 * `notified` entries are still waiting: they are offered later freed slots
 * too (after a cooldown), and the entry closes when the client books that
 * service, from the salon's page or from the panel.
 */
@Injectable()
export class WaitListService {
  private readonly logger = new Logger(WaitListService.name);
  /** The current time; tests replace it. */
  clock: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly sms: SmsService,
    private readonly whatsapp: WhatsAppTemplateService,
  ) {}

  /**
   * The panel's list. Clients' email and phone only for owner and admin:
   * a professional sees who is waiting, not their contact details.
   */
  async list(
    tenantId: string,
    opts: { status?: WaitListStatus; serviceId?: string } = {},
    viewer: { role?: string | null } = {},
  ) {
    await this.assertEnabled(tenantId);
    const showContact = SALON_MANAGERS.includes(viewer.role as UserRole);
    const rows = await this.prisma.waitList.findMany({
      where: {
        tenantId,
        ...(opts.status ? { status: opts.status } : {}),
        ...(opts.serviceId ? { serviceId: opts.serviceId } : {}),
      },
      orderBy: { createdAt: 'asc' },
      include: {
        client: { select: { firstName: true, lastName: true, email: true, phone: true } },
      },
    });
    const ids = [...new Set(rows.flatMap((r) => [r.serviceId, r.professionalId]).filter(Boolean))] as string[];
    const [services, professionals] = await Promise.all([
      this.prisma.service.findMany({ where: { tenantId, id: { in: ids } }, select: { id: true, name: true } }),
      this.prisma.professional.findMany({
        where: { tenantId, id: { in: ids } },
        select: { id: true, firstName: true, lastName: true },
      }),
    ]);
    const serviceName = new Map(services.map((s) => [s.id, s.name]));
    const proName = new Map(professionals.map((p) => [p.id, `${p.firstName} ${p.lastName}`.trim()]));
    return rows.map((r) => ({
      ...r,
      client: {
        firstName: r.client.firstName,
        lastName: r.client.lastName,
        // Placeholder addresses (clients created without one) are not emails.
        email: showContact ? realEmail(r.client.email) : null,
        phone: showContact ? r.client.phone ?? null : null,
      },
      contactHidden: !showContact,
      serviceName: serviceName.get(r.serviceId) ?? null,
      professionalName: r.professionalId ? proName.get(r.professionalId) ?? null : null,
    }));
  }

  async add(tenantId: string, dto: WaitListCreateDto) {
    await this.assertEnabled(tenantId);
    const [client, service, tenant] = await Promise.all([
      this.prisma.client.findFirst({ where: { id: dto.clientId, tenantId }, select: { id: true } }),
      this.prisma.service.findFirst({ where: { id: dto.serviceId, tenantId }, select: { id: true } }),
      this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } }),
    ]);
    if (!client) throw new NotFoundException('Cliente no encontrado');
    if (!service) throw new NotFoundException('Servicio no encontrado');
    if (dto.professionalId) {
      const pro = await this.prisma.professional.findFirst({ where: { id: dto.professionalId, tenantId } });
      if (!pro) throw new NotFoundException('Profesional no encontrado');
    }
    const window = this.checkWindow(
      dto.earliestDate ? parseDay(dto.earliestDate, 'Desde') : null,
      dto.latestDate ? parseDay(dto.latestDate, 'Hasta') : null,
      tenant?.timezone,
      { earliest: !!dto.earliestDate, latest: !!dto.latestDate },
    );
    const professionalId = dto.professionalId ?? null;

    // One active entry per client, service and professional. The lock makes
    // a double click (two requests at once) find the first one.
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`waitlist:${tenantId}:${dto.clientId}:${dto.serviceId}`}))`;
      await this.assertNoDuplicate(tx, tenantId, dto.clientId, dto.serviceId, professionalId);
      return tx.waitList.create({
        data: {
          tenantId,
          clientId: dto.clientId,
          serviceId: dto.serviceId,
          professionalId,
          earliestDate: window.earliest,
          latestDate: window.latest,
          notes: dto.notes ?? null,
          status: 'waiting',
        },
      });
    });
  }

  async update(tenantId: string, id: string, dto: WaitListUpdateDto) {
    const entry = await this.own(tenantId, id);
    if (dto.status === 'notified') {
      // Only a notice that went out makes an entry "notified".
      throw new BadRequestException('Usa "Avisar" para avisar al cliente');
    }
    const earliestGiven = dto.earliestDate !== undefined;
    const latestGiven = dto.latestDate !== undefined;
    let window: { earliest: Date | null; latest: Date | null } | null = null;
    if (earliestGiven || latestGiven) {
      const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
      window = this.checkWindow(
        earliestGiven ? (dto.earliestDate ? parseDay(dto.earliestDate, 'Desde') : null) : entry.earliestDate ?? null,
        latestGiven ? (dto.latestDate ? parseDay(dto.latestDate, 'Hasta') : null) : entry.latestDate ?? null,
        tenant?.timezone,
        // Only a date being set now must not be in the past.
        { earliest: earliestGiven && !!dto.earliestDate, latest: latestGiven && !!dto.latestDate },
      );
    }
    if (dto.status === 'expired') {
      throw new BadRequestException('Una entrada caduca sola; para cerrarla usa "Descartar"');
    }
    const reopening = dto.status === 'waiting' && !ACTIVE_STATUSES.includes(entry.status as WaitListStatus);
    if (reopening) {
      const latest = window && latestGiven ? window.latest : entry.latestDate ?? null;
      if (latest) {
        const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
        const today = salonClock(this.clock(), tenant?.timezone || DEFAULT_TZ).day;
        if (latest.toISOString().slice(0, 10) < today) {
          throw new BadRequestException('La fecha "Hasta" ya ha pasado: apúntalo de nuevo con otras fechas');
        }
      }
      await this.assertNoDuplicate(this.prisma, tenantId, entry.clientId, entry.serviceId, entry.professionalId ?? null, entry.id);
    }
    return this.prisma.waitList.update({
      where: { id },
      data: {
        ...(dto.status ? { status: dto.status } : {}),
        // Why it closed is set by the system or the client; the salon closing
        // or reopening the entry by hand clears it.
        ...(dto.status
          ? { closedReason: null, closedAt: ACTIVE_STATUSES.includes(dto.status) ? null : this.clock() }
          : {}),
        ...(window && earliestGiven ? { earliestDate: window.earliest } : {}),
        ...(window && latestGiven ? { latestDate: window.latest } : {}),
        ...(dto.notes !== undefined ? { notes: dto.notes } : {}),
      },
    });
  }

  async remove(tenantId: string, id: string) {
    await this.own(tenantId, id);
    await this.prisma.waitList.delete({ where: { id } });
    return { ok: true };
  }

  // ------------------------------------------------------------- settings

  async getSettings(tenantId: string) {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { waitListAutoNotify: true },
    });
    return { autoNotify: !!t?.waitListAutoNotify };
  }

  async updateSettings(tenantId: string, autoNotify: boolean) {
    await this.assertEnabled(tenantId);
    await this.prisma.tenant.update({ where: { id: tenantId }, data: { waitListAutoNotify: autoNotify } });
    return { autoNotify };
  }

  /** Which channels can deliver today, so the panel can say so before "Avisar". */
  async channels(tenantId: string) {
    const wa = await this.whatsapp.canSend(tenantId, WAITLIST_SLOT_AVAILABLE).catch(() => ({ ok: false, reason: 'error' }));
    return {
      email: this.email.isConfigured(),
      sms: this.sms.isConfigured(),
      whatsapp: wa.ok,
      whatsappReason: wa.ok ? null : this.whatsappReason(wa.reason),
    };
  }

  // -------------------------------------------------------------- notices

  /** The "Avisar" button. */
  async notify(
    tenantId: string,
    id: string,
    slot: NotifyWaitListDto = {},
    actorId?: string | null,
  ): Promise<NotifyResult> {
    const entry = await this.own(tenantId, id);
    if (!ACTIVE_STATUSES.includes(entry.status as WaitListStatus)) {
      throw new BadRequestException('Esta entrada de la lista de espera ya está cerrada');
    }
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { timezone: true } });
    const today = salonClock(this.clock(), tenant?.timezone || DEFAULT_TZ).day;
    const stale = staleReason(entry, today, this.clock());
    if (stale) {
      await this.expire([entry.id], stale);
      throw new BadRequestException(
        stale === CLOSED_REASONS.windowPassed
          ? 'Esta entrada ha caducado: las fechas que pidió el cliente ya han pasado'
          : `Esta entrada ha caducado: llevaba más de ${WAIT_LIST_MAX_AGE_DAYS} días sin cambios`,
      );
    }
    if (slot.date) {
      const day = parseDay(slot.date, 'Fecha del hueco');
      if (day.toISOString().slice(0, 10) < today) {
        throw new BadRequestException('La fecha del hueco ya ha pasado');
      }
    }
    return this.deliver(tenantId, entry.id, slot, { actorId: actorId ?? null, auto: false });
  }

  /**
   * Called when an appointment is cancelled. With automatic notices on, up
   * to three waiting clients whose window covers the freed slot are told
   * (oldest request first), skipping the ones no channel can reach. Entries
   * already told about an earlier slot stay in line once their cooldown has
   * passed. Otherwise -- automatic notices off, at night, or nobody could be
   * reached -- the salon's managers get an in-app note so they can press
   * "Avisar".
   */
  async onAppointmentCancelled(args: {
    tenantId: string;
    serviceId: string;
    professionalId: string | null;
    date: Date;
    time?: string | null;
  }): Promise<NotifyResult[]> {
    if (!(await this.isEnabled(args.tenantId))) return [];
    const now = this.clock();
    // `date` is the salon day at midnight UTC; an entry starting the next
    // day does not cover it.
    const windowStart = args.date;
    const windowEnd = new Date(args.date.getTime() + 24 * 60 * 60 * 1000);
    const cooledDown = new Date(now.getTime() - AUTO_NOTIFY_COOLDOWN_MS);
    const rows = await this.prisma.waitList.findMany({
      where: {
        tenantId: args.tenantId,
        serviceId: args.serviceId,
        // Blocked clients and removed (anonymised) ones are not told.
        client: { status: 'active' },
        AND: [
          {
            OR: [
              { status: 'waiting' },
              { status: 'notified', OR: [{ notifiedAt: null }, { notifiedAt: { lt: cooledDown } }] },
            ],
          },
          ...(args.professionalId
            ? [{ OR: [{ professionalId: null }, { professionalId: args.professionalId }] }]
            : []),
          { OR: [{ earliestDate: null }, { earliestDate: { lt: windowEnd } }] },
          { OR: [{ latestDate: null }, { latestDate: { gte: windowStart } }] },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    if (rows.length === 0) return [];
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: args.tenantId },
      select: { waitListAutoNotify: true, timezone: true },
    });
    // Stale entries are not offered the slot; they are closed now rather
    // than at the next expiry run.
    const today = salonClock(now, tenant?.timezone || DEFAULT_TZ).day;
    const fresh: typeof rows = [];
    for (const r of rows) {
      const stale = staleReason(r, today, now);
      if (stale) await this.expire([r.id], stale);
      else fresh.push(r);
    }
    // One notice per client, even if she is on the list twice.
    const seen = new Set<string>();
    const matches = fresh.filter((r) => (seen.has(r.clientId) ? false : (seen.add(r.clientId), true)));
    if (matches.length === 0) return [];

    const slot: NotifyWaitListDto = {
      date: args.date.toISOString().slice(0, 10),
      time: args.time ?? undefined,
      professionalId: args.professionalId ?? undefined,
    };

    if (!tenant?.waitListAutoNotify) {
      await this.tellManagers(args.tenantId, args.serviceId, matches.length, slot, 'manual');
      return [];
    }

    // No automatic messages at night: the managers decide in the morning.
    if (isQuietHour(salonClock(now, tenant.timezone || DEFAULT_TZ).hour)) {
      await this.tellManagers(args.tenantId, args.serviceId, matches.length, slot, 'night');
      return [];
    }

    const ch = await this.channels(args.tenantId);
    if (!ch.email && !ch.sms && !ch.whatsapp) {
      await this.tellManagers(args.tenantId, args.serviceId, matches.length, slot, 'unreachable');
      return [];
    }

    const results: NotifyResult[] = [];
    let notified = 0;
    for (const m of matches.slice(0, AUTO_NOTIFY_MAX_ATTEMPTS)) {
      if (notified >= AUTO_NOTIFY_MAX) break;
      try {
        const r = await this.deliver(args.tenantId, m.id, slot, { actorId: null, auto: true });
        results.push(r);
        if (r.notified) notified++;
      } catch (err) {
        // Closed or blocked meanwhile: the next one.
        this.logger.warn(`wait-list: entry ${m.id} skipped: ${(err as Error).message}`);
      }
    }
    this.logger.log(
      `wait-list: freed slot tenant=${args.tenantId} service=${args.serviceId}: ` +
        `${notified}/${results.length} clients notified`,
    );
    if (notified === 0) {
      await this.tellManagers(args.tenantId, args.serviceId, matches.length, slot, 'unreachable');
    }
    return results;
  }

  /**
   * A client booked a service: her active entries for it close as
   * "Ha reservado" (an entry for another professional stays). Called after
   * any new appointment, online or from the panel.
   */
  async onAppointmentBooked(args: {
    tenantId: string;
    clientId: string;
    serviceId: string;
    professionalId?: string | null;
  }): Promise<number> {
    const res = await this.prisma.waitList.updateMany({
      where: {
        tenantId: args.tenantId,
        clientId: args.clientId,
        serviceId: args.serviceId,
        status: { in: ACTIVE_STATUSES },
        ...(args.professionalId
          ? { OR: [{ professionalId: null }, { professionalId: args.professionalId }] }
          : {}),
      },
      data: { status: 'fulfilled' },
    });
    return res.count;
  }

  private async deliver(
    tenantId: string,
    entryId: string,
    slot: NotifyWaitListDto,
    opts: { actorId: string | null; auto: boolean },
  ): Promise<NotifyResult> {
    const entry = await this.prisma.waitList.findFirst({
      where: { id: entryId, tenantId },
      include: {
        client: {
          select: {
            id: true,
            firstName: true,
            email: true,
            phone: true,
            communicationPreferences: true,
            status: true,
          },
        },
      },
    });
    if (!entry) throw new NotFoundException('Entrada de la lista de espera no encontrada');
    if (!ACTIVE_STATUSES.includes(entry.status as WaitListStatus)) {
      throw new BadRequestException('Esta entrada de la lista de espera ya está cerrada');
    }
    const clientStatus = (entry.client as { status?: string }).status ?? 'active';
    if (clientStatus === 'blocked') {
      throw new BadRequestException('Este cliente está bloqueado: no se le envían avisos');
    }
    if (clientStatus !== 'active') {
      throw new BadRequestException('Este cliente está dado de baja: no se le envían avisos');
    }
    if (slot.date) parseDay(slot.date, 'Fecha del hueco');

    const [tenant, service] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: {
          name: true,
          slug: true,
          country: true,
          phone: true,
          customDomain: { select: { domain: true, verifiedAt: true } },
        },
      }),
      this.prisma.service.findFirst({
        where: { id: entry.serviceId, tenantId },
        select: { name: true, isOnlineBookable: true, isActive: true },
      }),
    ]);
    const professionalId = slot.professionalId ?? entry.professionalId ?? undefined;
    const professional = professionalId
      ? await this.prisma.professional.findFirst({
          where: { id: professionalId, tenantId },
          select: { firstName: true },
        })
      : null;

    const salonName = tenant?.name ?? 'el salón';
    const serviceName = service?.name ?? 'tu servicio';
    const slotText = this.slotText(slot, professional?.firstName);
    // A service the salon's page does not offer cannot be booked from a link.
    const bookable = service?.isOnlineBookable !== false && service?.isActive !== false;
    const bookingUrl = bookable
      ? this.bookingUrl(tenant, entry.serviceId, professionalId, slot.date)
      : null;
    const salonPhone = tenant?.phone?.trim() || null;
    const leaveUrl = this.leaveUrl(entry.id);
    const client = entry.client;
    const email = realEmail(client.email);
    const optedOut = (client.communicationPreferences ?? {}) as Record<string, unknown>;
    const allowed = async (channel: 'email' | 'sms' | 'whatsapp') =>
      optedOut[channel] !== false &&
      (await this.notifications.shouldSendNotification(client.id, NOTICE_TYPE, channel).catch(() => true));

    const outcomes: ChannelOutcome[] = [];

    // Email
    if (!email) {
      outcomes.push({ channel: 'email', status: 'skipped', reason: 'el cliente no tiene email' });
    } else if (!(await allowed('email'))) {
      outcomes.push({ channel: 'email', status: 'skipped', reason: 'el cliente no quiere recibir emails' });
    } else if (!this.email.isConfigured()) {
      outcomes.push({ channel: 'email', status: 'skipped', reason: 'no hay proveedor de email configurado' });
    } else {
      const res = await this.email
        .sendEmail({
          to: email,
          subject: `Se ha liberado un hueco en ${salonName}`,
          html: this.emailBody({ firstName: client.firstName, salonName, serviceName, slotText, bookingUrl, salonPhone, leaveUrl }),
        })
        .catch((err) => ({ success: false, error: (err as Error).message }));
      if (!res.success) this.logger.warn(`wait-list email failed for entry ${entry.id}: ${res.error}`);
      outcomes.push(
        res.success
          ? { channel: 'email', status: 'sent' }
          : { channel: 'email', status: 'failed', reason: 'el proveedor de email no ha podido enviarlo' },
      );
    }

    // Phone: the salon's WhatsApp when it can, SMS otherwise. Not both.
    let phoneSent = false;
    if (!client.phone) {
      outcomes.push({ channel: 'whatsapp', status: 'skipped', reason: 'el cliente no tiene teléfono' });
      outcomes.push({ channel: 'sms', status: 'skipped', reason: 'el cliente no tiene teléfono' });
    } else {
      if (!(await allowed('whatsapp'))) {
        outcomes.push({ channel: 'whatsapp', status: 'skipped', reason: 'el cliente no quiere recibir WhatsApp' });
      } else {
        const res = await this.whatsapp
          .sendWaitlistSlot(tenantId, {
            phone: client.phone,
            clientName: client.firstName,
            salonName,
            serviceName,
            slotText,
            // The template reads "Puedes reservarlo aquí: {{5}}".
            bookingUrl: bookingUrl ?? (salonPhone ? `llamando al ${salonPhone}` : 'contactando con el salón'),
            country: tenant?.country ?? undefined,
          })
          .catch((err) => ({ sent: false, reason: `error: ${(err as Error).message}` }));
        if (res.sent) {
          phoneSent = true;
          outcomes.push({ channel: 'whatsapp', status: 'sent' });
        } else {
          const failed = res.reason?.startsWith('meta_') || res.reason?.startsWith('error');
          if (failed) this.logger.warn(`wait-list WhatsApp failed for entry ${entry.id}: ${res.reason}`);
          outcomes.push({
            channel: 'whatsapp',
            status: failed ? 'failed' : 'skipped',
            reason: this.whatsappReason(res.reason),
          });
        }
      }

      if (phoneSent) {
        outcomes.push({ channel: 'sms', status: 'skipped', reason: 'ya avisado por WhatsApp' });
      } else if (!(await allowed('sms'))) {
        outcomes.push({ channel: 'sms', status: 'skipped', reason: 'el cliente no quiere recibir SMS' });
      } else if (!this.sms.isConfigured()) {
        outcomes.push({ channel: 'sms', status: 'skipped', reason: 'no hay proveedor de SMS configurado' });
      } else {
        const how = bookingUrl
          ? `Resérvalo: ${bookingUrl}`
          : salonPhone
            ? `Para reservarlo, llama al salón: ${salonPhone}`
            : 'Para reservarlo, contacta con el salón.';
        const res = await this.sms
          .sendSms({
            to: client.phone,
            body: `${salonName}: se ha liberado un hueco para ${serviceName} (${slotText}). ${how}${
              leaveUrl ? ` Si ya no te interesa: ${leaveUrl}` : ''
            }`,
          })
          .catch((err) => ({ success: false, error: (err as Error).message }));
        if (!res.success) this.logger.warn(`wait-list SMS failed for entry ${entry.id}: ${res.error}`);
        outcomes.push(
          res.success
            ? { channel: 'sms', status: 'sent' }
            : { channel: 'sms', status: 'failed', reason: 'el proveedor de SMS no ha podido enviarlo' },
        );
      }
    }

    // Clients have no account on the salon's site any more, so there is no
    // in-app notice for them: email, WhatsApp and SMS are the channels.

    const delivered = outcomes.filter((o) => o.channel !== 'inApp' && o.status === 'sent');
    const notified = delivered.length > 0;
    const now = this.clock();
    // Only an entry still open is touched: one closed while the notice went
    // out ("Ha reservado", "Descartar") keeps its status.
    await this.prisma.waitList.updateMany({
      where: { id: entry.id, tenantId, status: { in: ACTIVE_STATUSES } },
      data: {
        lastNotification: {
          at: now.toISOString(),
          auto: opts.auto,
          by: opts.actorId,
          slot: { date: slot.date ?? null, time: slot.time ?? null, professionalId: professionalId ?? null },
          bookingUrl,
          channels: outcomes,
        } as any,
        ...(notified
          ? { status: 'notified', notifiedAt: now, notifyCount: { increment: 1 } }
          : {}),
      },
    });

    const label: Record<Channel, string> = { email: 'email', whatsapp: 'WhatsApp', sms: 'SMS', inApp: 'aviso en la web' };
    const summary = notified
      ? `Avisado por ${delivered.map((o) => label[o.channel]).join(' y ')}`
      : `No se ha podido avisar: ${outcomes
          .filter((o) => o.channel !== 'inApp')
          .map((o) => `${label[o.channel]}, ${o.reason ?? o.status}`)
          .join('; ')}`;
    return { notified, channels: outcomes, bookingUrl, summary };
  }

  /** An in-app note for the salon's active owners and admins about a freed slot. */
  private async tellManagers(
    tenantId: string,
    serviceId: string,
    waiting: number,
    slot: NotifyWaitListDto,
    kind: ManagerNote,
  ) {
    const [service, managers] = await Promise.all([
      this.prisma.service.findFirst({ where: { id: serviceId, tenantId }, select: { name: true } }),
      this.prisma.user.findMany({
        where: { tenantId, isActive: true, role: { in: [UserRole.owner, UserRole.admin] } },
        select: { id: true },
      }),
    ]);
    const when = this.slotText(slot);
    const what = `un hueco de ${service?.name ?? 'este servicio'} (${when})`;
    const who = waiting === 1 ? 'Hay 1 cliente esperando' : `Hay ${waiting} clientes esperando`;
    const message =
      kind === 'night'
        ? `Se ha liberado ${what} de noche, fuera del horario de avisos automáticos (de ${QUIET_UNTIL_HOUR}:00 a ${QUIET_FROM_HOUR}:00): no se ha avisado a nadie. ${who}; avísales desde Lista de espera.`
        : kind === 'unreachable'
          ? `Se ha liberado ${what} y el aviso automático no ha llegado a nadie (sin email ni teléfono, sin canales configurados o sin permiso). ${who}; revisa la Lista de espera.`
          : `${who} ${what}. Avísales desde Lista de espera.`;
    for (const m of managers) {
      await this.notifications
        .create({
          tenantId,
          userId: m.id,
          type: NotificationType.WAITLIST_SLOT_AVAILABLE,
          title: kind === 'unreachable' ? 'Hueco libre: nadie avisado' : 'Hueco libre con lista de espera',
          message,
          data: { serviceId, slot, reason: kind },
        })
        .catch((err) => this.logger.warn(`wait-list manager notice failed: ${(err as Error).message}`));
    }
  }

  private slotText(slot: NotifyWaitListDto, professionalFirstName?: string | null): string {
    if (!slot.date) return 'hay huecos disponibles';
    let text = spanishDate(new Date(`${slot.date.slice(0, 10)}T00:00:00.000Z`));
    if (slot.time) text += ` a las ${slot.time}`;
    if (professionalFirstName) text += ` con ${professionalFirstName}`;
    return text;
  }

  /** The salon's public booking page (its own domain when it has one), with the service and slot filled in. */
  private bookingUrl(
    tenant: { slug: string; customDomain?: { domain: string; verifiedAt: Date | null } | null } | null | undefined,
    serviceId?: string,
    professionalId?: string,
    date?: string,
  ): string {
    const base = salonPublicUrlFromEnv(tenant?.slug ?? '', tenant?.customDomain ?? null);
    const qs = new URLSearchParams();
    if (serviceId) qs.set('serviceId', serviceId);
    if (professionalId) qs.set('professionalId', professionalId);
    if (date) qs.set('date', date);
    if (![...qs.keys()].length) return base;
    const url = new URL(base);
    url.search = qs.toString();
    return url.toString();
  }

  private whatsappReason(reason?: string): string {
    if (!reason) return 'no disponible';
    if (WHATSAPP_REASONS[reason]) return WHATSAPP_REASONS[reason];
    if (reason.startsWith('template_')) return 'Meta aún no ha aprobado la plantilla de aviso de WhatsApp';
    if (reason.startsWith('meta_')) return `WhatsApp rechazó el envío (código ${reason.slice(5)})`;
    if (reason.startsWith('error')) return 'no se ha podido enviar por WhatsApp';
    return 'no disponible';
  }

  private emailBody(v: {
    firstName: string;
    salonName: string;
    serviceName: string;
    slotText: string;
    bookingUrl: string | null;
    salonPhone: string | null;
    leaveUrl?: string | null;
  }) {
    const how = v.bookingUrl
      ? `<p><a href="${escapeHtml(v.bookingUrl)}">Reservar ahora</a></p>`
      : v.salonPhone
        ? `<p>Para reservarlo, llama al salón: <strong>${escapeHtml(v.salonPhone)}</strong>.</p>`
        : `<p>Para reservarlo, ponte en contacto con el salón.</p>`;
    return `<p>Hola ${escapeHtml(v.firstName)},</p>
<p>Estabas en la lista de espera de <strong>${escapeHtml(v.salonName)}</strong> para <strong>${escapeHtml(v.serviceName)}</strong>, y se ha liberado un hueco: ${escapeHtml(v.slotText)}.</p>
${how}
<p style="font-size:12px;color:#666">El hueco es para quien reserve primero.${
      v.leaveUrl
        ? ` ¿Ya no te interesa? <a href="${escapeHtml(v.leaveUrl)}" style="color:#666">Sal de la lista de espera</a> y no te avisaremos más.`
        : ' Si ya no te interesa, ignora este mensaje.'
    }</p>`;
  }

  // -------------------------------------------------------------- expiry

  /**
   * Closes stale entries as "expired" (see staleReason): a "hasta" in the
   * past (salon's calendar), or open-ended and untouched for
   * WAIT_LIST_MAX_AGE_DAYS. Run every hour by WaitListExpiryScheduler, so a
   * salon in any time zone sees its entries close soon after its midnight.
   * Not tied to the plan: an entry closes even if the salon lost the feature.
   */
  async expireStale(limit = 1000): Promise<number> {
    const now = this.clock();
    const cutoff = new Date(now.getTime() - WAIT_LIST_MAX_AGE_DAYS * DAY_MS);
    // A "hasta" before tomorrow (UTC) may be past in some salon's calendar;
    // staleReason decides with the salon's own day.
    const tomorrow = new Date(`${now.toISOString().slice(0, 10)}T00:00:00.000Z`);
    tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
    const rows = await this.prisma.waitList.findMany({
      where: {
        status: { in: ACTIVE_STATUSES },
        OR: [
          { latestDate: { lt: tomorrow } },
          {
            latestDate: null,
            updatedAt: { lt: cutoff },
            OR: [{ earliestDate: null }, { earliestDate: { lt: cutoff } }],
          },
        ],
      },
      select: {
        id: true,
        earliestDate: true,
        latestDate: true,
        updatedAt: true,
        tenant: { select: { timezone: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    const byReason: Record<ExpiryReason, string[]> = { window_passed: [], too_old: [] };
    for (const r of rows) {
      const today = salonClock(now, r.tenant?.timezone || DEFAULT_TZ).day;
      const reason = staleReason(r, today, now);
      if (reason) byReason[reason].push(r.id);
    }
    let closed = 0;
    for (const reason of Object.keys(byReason) as ExpiryReason[]) {
      closed += await this.expire(byReason[reason], reason);
    }
    return closed;
  }

  /** Marks open entries expired; one closed meanwhile keeps its status. */
  private async expire(ids: string[], reason: ExpiryReason): Promise<number> {
    if (ids.length === 0) return 0;
    const res = await this.prisma.waitList.updateMany({
      where: { id: { in: ids }, status: { in: ACTIVE_STATUSES } },
      data: { status: 'expired', closedReason: reason, closedAt: this.clock() },
    });
    return res.count;
  }

  // ------------------------------------------- "Ya no me interesa" (public)

  /** The link's page: what the client is waiting for, and whether still. */
  async describeLeaveLink(token: string): Promise<LeaveLinkInfo> {
    const entry = await this.byLeaveToken(token);
    return this.leaveInfo(entry);
  }

  /**
   * The client leaves the list from the link in a notice: no account, no
   * sign-in. Idempotent; an entry closed meanwhile (booked, discarded,
   * expired) keeps its status. Not tied to the plan.
   */
  async leaveByToken(token: string): Promise<LeaveLinkInfo> {
    const entry = await this.byLeaveToken(token);
    if (ACTIVE_STATUSES.includes(entry.status as WaitListStatus)) {
      await this.prisma.waitList.updateMany({
        where: { id: entry.id, status: { in: ACTIVE_STATUSES } },
        data: { status: 'cancelled', closedReason: CLOSED_REASONS.clientLeft, closedAt: this.clock() },
      });
    }
    return { ...(await this.leaveInfo(entry)), waiting: false };
  }

  private async byLeaveToken(token: string) {
    const invalid = new NotFoundException('Enlace no válido');
    const id = parseWaitListLeaveToken(token, process.env.JWT_SECRET ?? '');
    if (!id) throw invalid;
    const entry = await this.prisma.waitList.findUnique({
      where: { id },
      select: { id: true, tenantId: true, serviceId: true, status: true },
    });
    if (!entry) throw invalid;
    return entry;
  }

  private async leaveInfo(entry: { tenantId: string; serviceId: string; status: string }): Promise<LeaveLinkInfo> {
    const [tenant, service] = await Promise.all([
      this.prisma.tenant.findUnique({ where: { id: entry.tenantId }, select: { name: true } }),
      this.prisma.service.findFirst({ where: { id: entry.serviceId, tenantId: entry.tenantId }, select: { name: true } }),
    ]);
    return {
      salonName: tenant?.name ?? 'el salón',
      serviceName: service?.name ?? 'el servicio',
      waiting: ACTIVE_STATUSES.includes(entry.status as WaitListStatus),
    };
  }

  /** The "Ya no me interesa" page for an entry; null without a signing secret. */
  private leaveUrl(entryId: string): string | null {
    const secret = process.env.JWT_SECRET;
    if (!secret) return null;
    const appBase = (process.env.APP_BASE_URL || process.env.FRONTEND_URL || 'https://app.kiraroom.net').replace(/\/+$/, '');
    return `${appBase}/public/lista-espera/${encodeURIComponent(waitListLeaveToken(entryId, secret))}`;
  }

  // -------------------------------------------------------------- helpers

  /**
   * The client's window: real dates, "hasta" not before "desde", and a date
   * being set not already past (salon's calendar).
   */
  private checkWindow(
    earliest: Date | null,
    latest: Date | null,
    timeZone: string | null | undefined,
    setNow: { earliest: boolean; latest: boolean },
  ): { earliest: Date | null; latest: Date | null } {
    const today = salonClock(this.clock(), timeZone || DEFAULT_TZ).day;
    const day = (d: Date) => d.toISOString().slice(0, 10);
    if (setNow.earliest && earliest && day(earliest) < today) {
      throw new BadRequestException('La fecha "Desde" ya ha pasado');
    }
    if (setNow.latest && latest && day(latest) < today) {
      throw new BadRequestException('La fecha "Hasta" ya ha pasado');
    }
    if (earliest && latest && latest.getTime() < earliest.getTime()) {
      throw new BadRequestException('La fecha "Hasta" no puede ser anterior a "Desde"');
    }
    return { earliest, latest };
  }

  private async assertNoDuplicate(
    db: Pick<PrismaService, 'waitList'>,
    tenantId: string,
    clientId: string,
    serviceId: string,
    professionalId: string | null,
    exceptId?: string,
  ) {
    const dup = await db.waitList.findFirst({
      where: {
        tenantId,
        clientId,
        serviceId,
        professionalId,
        status: { in: ACTIVE_STATUSES },
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
      select: { id: true },
    });
    if (dup) {
      throw new ConflictException(
        'Este cliente ya está en la lista de espera para este servicio. Edita esa entrada en lugar de crear otra.',
      );
    }
  }

  private async own(tenantId: string, id: string) {
    await this.assertEnabled(tenantId);
    const row = await this.prisma.waitList.findFirst({ where: { id, tenantId } });
    if (!row) throw new NotFoundException('Entrada de la lista de espera no encontrada');
    return row;
  }

  private async assertEnabled(tenantId: string) {
    if (!(await this.isEnabled(tenantId))) {
      throw new NotFoundException(
        'La lista de espera no está incluida en tu plan. Está en Pro o con el complemento de recepcionista avanzada.',
      );
    }
  }

  private async isEnabled(tenantId: string): Promise<boolean> {
    return this.flags.isFeatureUnlocked(tenantId, 'virtual_receptionist_advanced');
  }
}
