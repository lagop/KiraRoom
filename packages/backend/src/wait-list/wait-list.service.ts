import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../common/prisma/prisma.service';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';
import { NotificationsService } from '../notifications/notifications.service';
import { EmailService } from '../notifications/services/email.service';
import { SmsService } from '../notifications/services/sms.service';
import { NotificationType } from '../notifications/dto';
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
  bookingUrl: string;
  /** One line for the panel, in Spanish. */
  summary: string;
}

/** How many waiting clients an automatic notice reaches per freed slot. */
const AUTO_NOTIFY_MAX = 3;
const NOTICE_TYPE = 'waitlist_slot_available';

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
 * Wait-list for fully booked services, gated behind
 * `virtual_receptionist_advanced`.
 *
 * "Avisar" used to flip the entry to `notified` and send nothing, and a
 * cancellation marked every matching client as notified the same way. Now a
 * notice really goes out through the salon's channels -- email, then the
 * salon's WhatsApp number (approved template) or SMS -- respecting what the
 * client opted out of, with a link to book the slot. The entry is only
 * marked `notified` when one of them delivered; otherwise the answer says
 * why nothing went (no provider configured, no phone, opted out...).
 */
@Injectable()
export class WaitListService {
  private readonly logger = new Logger(WaitListService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly sms: SmsService,
    private readonly whatsapp: WhatsAppTemplateService,
  ) {}

  async list(
    tenantId: string,
    opts: { status?: WaitListStatus; serviceId?: string } = {},
  ) {
    await this.assertEnabled(tenantId);
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
      serviceName: serviceName.get(r.serviceId) ?? null,
      professionalName: r.professionalId ? proName.get(r.professionalId) ?? null : null,
    }));
  }

  async add(tenantId: string, dto: WaitListCreateDto) {
    await this.assertEnabled(tenantId);
    const [client, service] = await Promise.all([
      this.prisma.client.findFirst({ where: { id: dto.clientId, tenantId }, select: { id: true } }),
      this.prisma.service.findFirst({ where: { id: dto.serviceId, tenantId }, select: { id: true } }),
    ]);
    if (!client) throw new NotFoundException('Cliente no encontrado');
    if (!service) throw new NotFoundException('Servicio no encontrado');
    if (dto.professionalId) {
      const pro = await this.prisma.professional.findFirst({ where: { id: dto.professionalId, tenantId } });
      if (!pro) throw new NotFoundException('Profesional no encontrado');
    }
    return this.prisma.waitList.create({
      data: {
        tenantId,
        clientId: dto.clientId,
        serviceId: dto.serviceId,
        professionalId: dto.professionalId ?? null,
        earliestDate: dto.earliestDate ? new Date(dto.earliestDate) : null,
        latestDate: dto.latestDate ? new Date(dto.latestDate) : null,
        notes: dto.notes ?? null,
        status: 'waiting',
      },
    });
  }

  async update(tenantId: string, id: string, dto: WaitListUpdateDto) {
    await this.own(tenantId, id);
    if (dto.status === 'notified') {
      // Only a notice that went out makes an entry "notified".
      throw new BadRequestException('Usa "Avisar" para avisar al cliente');
    }
    return this.prisma.waitList.update({
      where: { id },
      data: {
        ...(dto.status ? { status: dto.status } : {}),
        ...(dto.earliestDate !== undefined
          ? { earliestDate: dto.earliestDate ? new Date(dto.earliestDate) : null }
          : {}),
        ...(dto.latestDate !== undefined
          ? { latestDate: dto.latestDate ? new Date(dto.latestDate) : null }
          : {}),
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
    if (entry.status === 'cancelled' || entry.status === 'fulfilled') {
      throw new BadRequestException('Esta entrada de la lista de espera ya está cerrada');
    }
    return this.deliver(tenantId, entry.id, slot, { actorId: actorId ?? null, auto: false });
  }

  /**
   * Called when an appointment is cancelled. With automatic notices on, the
   * first waiting clients whose window covers the freed slot are told
   * (oldest request first). Otherwise the salon's managers get an in-app
   * note saying who is waiting, so they can press "Avisar".
   */
  async onAppointmentCancelled(args: {
    tenantId: string;
    serviceId: string;
    professionalId: string | null;
    date: Date;
    time?: string | null;
  }): Promise<NotifyResult[]> {
    if (!(await this.isEnabled(args.tenantId))) return [];
    const windowStart = args.date;
    const windowEnd = new Date(args.date.getTime() + 24 * 60 * 60 * 1000);
    const matches = await this.prisma.waitList.findMany({
      where: {
        tenantId: args.tenantId,
        serviceId: args.serviceId,
        status: 'waiting',
        ...(args.professionalId
          ? { OR: [{ professionalId: null }, { professionalId: args.professionalId }] }
          : {}),
        AND: [
          { OR: [{ earliestDate: null }, { earliestDate: { lte: windowEnd } }] },
          { OR: [{ latestDate: null }, { latestDate: { gte: windowStart } }] },
        ],
      },
      orderBy: { createdAt: 'asc' },
      take: 20,
    });
    if (matches.length === 0) return [];

    const tenant = await this.prisma.tenant.findUnique({
      where: { id: args.tenantId },
      select: { waitListAutoNotify: true },
    });
    const slot: NotifyWaitListDto = {
      date: args.date.toISOString().slice(0, 10),
      time: args.time ?? undefined,
      professionalId: args.professionalId ?? undefined,
    };

    if (tenant?.waitListAutoNotify) {
      const results: NotifyResult[] = [];
      for (const m of matches.slice(0, AUTO_NOTIFY_MAX)) {
        results.push(await this.deliver(args.tenantId, m.id, slot, { actorId: null, auto: true }));
      }
      this.logger.log(
        `wait-list: freed slot tenant=${args.tenantId} service=${args.serviceId}: ` +
          `${results.filter((r) => r.notified).length}/${results.length} clients notified`,
      );
      return results;
    }

    await this.tellManagers(args.tenantId, args.serviceId, matches.length, slot);
    return [];
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
          select: { id: true, firstName: true, email: true, phone: true, communicationPreferences: true },
        },
      },
    });
    if (!entry) throw new NotFoundException('Entrada de la lista de espera no encontrada');
    const [tenant, service] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true, slug: true, country: true },
      }),
      this.prisma.service.findFirst({ where: { id: entry.serviceId, tenantId }, select: { name: true } }),
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
    const bookingUrl = this.bookingUrl(tenant?.slug, entry.serviceId, professionalId, slot.date);
    const client = entry.client;
    const optedOut = (client.communicationPreferences ?? {}) as Record<string, unknown>;
    const allowed = async (channel: 'email' | 'sms' | 'whatsapp') =>
      optedOut[channel] !== false &&
      (await this.notifications.shouldSendNotification(client.id, NOTICE_TYPE, channel).catch(() => true));

    const outcomes: ChannelOutcome[] = [];

    // Email
    if (!client.email) {
      outcomes.push({ channel: 'email', status: 'skipped', reason: 'el cliente no tiene email' });
    } else if (!(await allowed('email'))) {
      outcomes.push({ channel: 'email', status: 'skipped', reason: 'el cliente no quiere recibir emails' });
    } else if (!this.email.isConfigured()) {
      outcomes.push({ channel: 'email', status: 'skipped', reason: 'no hay proveedor de email configurado' });
    } else {
      const res = await this.email.sendEmail({
        to: client.email,
        subject: `Se ha liberado un hueco en ${salonName}`,
        html: this.emailBody({ firstName: client.firstName, salonName, serviceName, slotText, bookingUrl }),
      });
      outcomes.push(
        res.success
          ? { channel: 'email', status: 'sent' }
          : { channel: 'email', status: 'failed', reason: res.error ?? 'error del proveedor de email' },
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
            bookingUrl,
            country: tenant?.country ?? undefined,
          })
          .catch((err) => ({ sent: false, reason: `error: ${(err as Error).message}` }));
        if (res.sent) {
          phoneSent = true;
          outcomes.push({ channel: 'whatsapp', status: 'sent' });
        } else {
          const failed = res.reason?.startsWith('meta_') || res.reason?.startsWith('error');
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
        const res = await this.sms.sendSms({
          to: client.phone,
          body: `${salonName}: se ha liberado un hueco para ${serviceName} (${slotText}). Resérvalo: ${bookingUrl}`,
        });
        outcomes.push(
          res.success
            ? { channel: 'sms', status: 'sent' }
            : { channel: 'sms', status: 'failed', reason: res.error ?? 'error del proveedor de SMS' },
        );
      }
    }

    // The client portal's bell. Recorded, but it does not count as a notice:
    // nobody sees it unless they happen to log in.
    try {
      await this.notifications.create({
        tenantId,
        clientId: client.id,
        type: NotificationType.WAITLIST_SLOT_AVAILABLE,
        title: 'Hueco libre',
        message: `Se ha liberado un hueco para ${serviceName} (${slotText}).`,
        data: { waitListId: entry.id, bookingUrl },
      });
      outcomes.push({ channel: 'inApp', status: 'sent', reason: 'lo verá al entrar en su área de cliente' });
    } catch (err) {
      outcomes.push({ channel: 'inApp', status: 'failed', reason: (err as Error).message });
    }

    const delivered = outcomes.filter((o) => o.channel !== 'inApp' && o.status === 'sent');
    const notified = delivered.length > 0;
    const now = new Date();
    await this.prisma.waitList.update({
      where: { id: entry.id },
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

  private async tellManagers(tenantId: string, serviceId: string, waiting: number, slot: NotifyWaitListDto) {
    const [service, managers] = await Promise.all([
      this.prisma.service.findFirst({ where: { id: serviceId, tenantId }, select: { name: true } }),
      this.prisma.user.findMany({
        where: { tenantId, role: { in: [UserRole.owner, UserRole.admin] } },
        select: { id: true },
      }),
    ]);
    const when = this.slotText(slot);
    for (const m of managers) {
      await this.notifications
        .create({
          tenantId,
          userId: m.id,
          type: NotificationType.WAITLIST_SLOT_AVAILABLE,
          title: 'Hueco libre con lista de espera',
          message:
            `${waiting === 1 ? 'Hay 1 cliente esperando' : `Hay ${waiting} clientes esperando`} ` +
            `un hueco de ${service?.name ?? 'este servicio'} (${when}). Avísales desde Lista de espera.`,
          data: { serviceId, slot },
        })
        .catch((err) => this.logger.warn(`wait-list manager notice failed: ${(err as Error).message}`));
    }
  }

  private slotText(slot: NotifyWaitListDto, professionalFirstName?: string | null): string {
    if (!slot.date) return 'hay huecos disponibles';
    let text = spanishDate(new Date(`${slot.date}T00:00:00.000Z`));
    if (slot.time) text += ` a las ${slot.time}`;
    if (professionalFirstName) text += ` con ${professionalFirstName}`;
    return text;
  }

  /** The salon's public booking page, with the service (and slot) filled in. */
  private bookingUrl(slug?: string | null, serviceId?: string, professionalId?: string, date?: string): string {
    const base = (process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/$/, '');
    const qs = new URLSearchParams();
    if (serviceId) qs.set('serviceId', serviceId);
    if (professionalId) qs.set('professionalId', professionalId);
    if (date) qs.set('date', date);
    const q = qs.toString();
    return `${base}/sites/${slug ?? ''}${q ? `?${q}` : ''}`;
  }

  private whatsappReason(reason?: string): string {
    if (!reason) return 'no disponible';
    if (WHATSAPP_REASONS[reason]) return WHATSAPP_REASONS[reason];
    if (reason.startsWith('template_')) return 'Meta aún no ha aprobado la plantilla de aviso de WhatsApp';
    if (reason.startsWith('meta_')) return `WhatsApp rechazó el envío (código ${reason.slice(5)})`;
    return reason;
  }

  private emailBody(v: { firstName: string; salonName: string; serviceName: string; slotText: string; bookingUrl: string }) {
    return `<p>Hola ${escapeHtml(v.firstName)},</p>
<p>Estabas en la lista de espera de <strong>${escapeHtml(v.salonName)}</strong> para <strong>${escapeHtml(v.serviceName)}</strong>, y se ha liberado un hueco: ${escapeHtml(v.slotText)}.</p>
<p><a href="${escapeHtml(v.bookingUrl)}">Reservar ahora</a></p>
<p style="font-size:12px;color:#666">El hueco es para quien reserve primero. Si ya no te interesa, ignora este mensaje.</p>`;
  }

  // -------------------------------------------------------------- helpers

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
