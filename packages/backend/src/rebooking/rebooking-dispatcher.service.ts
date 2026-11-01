import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../common/prisma/prisma.service";
import { ClientCadenceService } from "./client-cadence.service";
import { AppointmentStatus, RebookChannel, RebookStatus } from "@prisma/client";
import { FeatureFlagService } from "../common/feature-flags/feature-flag.service";
import { EmailService } from "../notifications/services/email.service";
import { realEmail } from "../common/placeholder-email";
import { escapeHtml } from "../common/html-escape";
import { withinSendingHours } from "../whatsapp/campaigns/campaign-template";
import {
  clientsWhoAcceptedWhatsAppMarketing,
  clientsWhoRefusedMarketing,
} from "../consent/marketing-consent";
import { EmailSuppressionService } from "../email-campaigns/email-suppression.service";
import { EmailUnsubscribeService } from "../email-campaigns/email-unsubscribe.service";

interface SendResult {
  ok: boolean;
  channel: RebookChannel;
  error?: string;
  /** Retrying cannot help (no address, channel not wired): skip this cycle. */
  permanent?: boolean;
}

interface CadenceStats {
  avgDays: number;
  stdDevDays: number;
  lastVisit?: string;
}

interface RebookClient {
  id: string;
  firstName: string;
  email: string | null;
  phone: string | null;
  status: string;
}

const CRON_BATCH_SIZE = 500;
/** Pages of CRON_BATCH_SIZE read per tick, so rows that wait cannot starve the rest. */
const MAX_PAGES_PER_TICK = 10;
const CRON_PARALLEL_TENANTS = 8;
/** Failed sends for one client and service in a day before the cycle is skipped. */
const MAX_FAILED_SENDS_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * A reminder that fell due while nothing could send it (the server was down,
 * the salon was outside its sending hours all day) still goes out within
 * this many days; older ones wait for the next cycle.
 */
export const OVERDUE_WINDOW_DAYS = 3;
/**
 * How long a tick owns a row it claimed. Under the hourly tick, so a failed
 * send is retried on the next tick, and long enough that an overlapping tick
 * or a second instance never sends the same reminder twice.
 */
export const CLAIM_LEASE_MS = 50 * 60 * 1000;
const DEFAULT_TIMEZONE = "Europe/Madrid";

/** "2026-11-04": the calendar day of `at` where the salon is. */
function localDay(at: Date, timeZone: string): string {
  const format = (tz: string) =>
    new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", day: "2-digit", timeZone: tz }).format(at);
  try {
    return format(timeZone);
  } catch {
    return format(DEFAULT_TIMEZONE);
  }
}

/** "martes, 4 de noviembre", in the salon's time zone. */
function longDayEs(at: Date, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = { weekday: "long", day: "numeric", month: "long" };
  try {
    return at.toLocaleDateString("es-ES", { ...options, timeZone });
  } catch {
    return at.toLocaleDateString("es-ES", { ...options, timeZone: DEFAULT_TIMEZONE });
  }
}

/**
 * The "vuelve a reservar" reminders: a client whose usual cycle for a
 * service is coming round gets one email inviting her to book it again.
 *
 * They are commercial communications (LSSI art. 21), not appointment
 * notices, so they follow the campaigns' rules: only active clients, never
 * someone who refused promotions or whose address bounced, complained or
 * unsubscribed, only within the salon's sending hours, and always with the
 * same signed unsubscribe link the campaigns carry (EmailUnsubscribeService).
 */
@Injectable()
export class RebookingDispatcherService {
  private readonly logger = new Logger(RebookingDispatcherService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cadence: ClientCadenceService,
    private readonly emailService: EmailService,
    private readonly flags: FeatureFlagService,
    private readonly suppressions: EmailSuppressionService,
    private readonly unsubscribes: EmailUnsubscribeService,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async runHourlyTick() {
    return this.runDailyTick();
  }

  /**
   * Sends the reminders that are due: those whose day has come where the
   * salon is, or came within the last OVERDUE_WINDOW_DAYS. Outside the
   * salon's sending hours (9:00-21:00, as WhatsApp campaigns) they are left
   * for a later tick, not skipped. It used to take the cadences of the
   * current UTC day at the first tick after midnight, so the emails went out
   * at 01:00-02:00 in Madrid, and a day the cron missed was never sent.
   */
  async runDailyTick(
    now: Date = new Date(),
  ): Promise<{ processed: number; sent: number; skipped: number; deferred: number }> {
    const from = new Date(now.getTime() - OVERDUE_WINDOW_DAYS * DAY_MS);
    // A salon's "today" can end up to a day after the UTC one; the exact
    // local-day test is below.
    const until = new Date(now.getTime() + DAY_MS);
    const claimableBefore = new Date(now.getTime() - CLAIM_LEASE_MS);

    const byTenant = new Map<string, Array<{ clientId: string }>>();
    let deferred = 0;
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES_PER_TICK; page++) {
      const rows = await this.prisma.clientCadence.findMany({
        where: {
          optedOut: false,
          nextRecommendedReminderAt: { gte: from, lt: until },
          OR: [{ dispatchClaimedAt: null }, { dispatchClaimedAt: { lt: claimableBefore } }],
        },
        select: {
          clientId: true,
          tenantId: true,
          nextRecommendedReminderAt: true,
          tenant: { select: { timezone: true } },
        },
        orderBy: [{ nextRecommendedReminderAt: "asc" }, { clientId: "asc" }],
        take: CRON_BATCH_SIZE,
        ...(cursor ? { cursor: { clientId: cursor }, skip: 1 } : {}),
      });
      for (const row of rows) {
        const timeZone = row.tenant?.timezone || DEFAULT_TIMEZONE;
        const dueAt = row.nextRecommendedReminderAt;
        if (!dueAt || localDay(dueAt, timeZone) > localDay(now, timeZone)) continue;
        if (!withinSendingHours(now, timeZone)) {
          deferred++;
          continue;
        }
        const list = byTenant.get(row.tenantId) ?? [];
        list.push({ clientId: row.clientId });
        byTenant.set(row.tenantId, list);
      }
      if (rows.length < CRON_BATCH_SIZE) break;
      cursor = rows[rows.length - 1].clientId;
    }

    let processed = 0;
    let sent = 0;
    let skipped = 0;
    const tenantIds = [...byTenant.keys()];
    for (let i = 0; i < tenantIds.length; i += CRON_PARALLEL_TENANTS) {
      const slice = tenantIds.slice(i, i + CRON_PARALLEL_TENANTS);
      const results = await Promise.allSettled(
        slice.map((tenantId) => this.processTenantBatch(tenantId, byTenant.get(tenantId)!)),
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          processed += r.value.processed;
          sent += r.value.sent;
          skipped += r.value.skipped;
        } else {
          skipped++;
          this.logger.warn(`Tenant batch failed: ${(r.reason as Error).message}`);
        }
      }
    }

    if (processed > 0 || deferred > 0) {
      this.logger.log(
        `Rebooking tick: processed=${processed} sent=${sent} skipped=${skipped} deferred=${deferred}`,
      );
    }
    return { processed, sent, skipped, deferred };
  }

  private async processTenantBatch(
    tenantId: string,
    rows: Array<{ clientId: string }>,
  ): Promise<{ processed: number; sent: number; skipped: number }> {
    // Re-check enabled flag at dispatch time — the cadence row may have been
    // computed when the tenant had rebooking enabled, but the owner may have
    // toggled it off afterwards. No work for disabled tenants.
    const cfg = await this.cadence.getTenantConfig(tenantId);
    if (!cfg.enabled) {
      return { processed: rows.length, sent: 0, skipped: rows.length };
    }

    // P2A-receptionist-advanced — "Proactive rescheduling" (advanced mode)
    // is a paid feature. Without it the reminder is the plain "you should
    // come back" one; advanced adds a date derived from her own cadence.
    const hasAdvanced = await this.flags.isFeatureUnlocked(tenantId, "virtual_receptionist_advanced");
    let sent = 0;
    let skipped = 0;
    for (const row of rows) {
      try {
        const result = await this.processOne(row.clientId, { hasAdvanced });
        if (result.ok) sent++;
        else skipped++;
      } catch (err) {
        skipped++;
        this.logger.warn(`Failed to process cadence ${row.clientId}: ${(err as Error).message}`);
      }
    }
    return { processed: rows.length, sent, skipped };
  }

  /**
   * Process a single cadence: claim it, check it may be sent, send, and
   * advance the prediction to the next cycle.
   *
   * The claim is the appointment reminders' one (NotificationsScheduler.remind):
   * the conditional update that stamps dispatchClaimedAt wins, so with two
   * backend instances, or a tick that overlaps the previous one, only one
   * goes on. The stamp is not cleared: it also spaces retries of a failed
   * send to one per hourly tick.
   */
  async processOne(
    cadenceId: string,
    opts: { hasAdvanced: boolean } = { hasAdvanced: true },
  ): Promise<{ ok: boolean; reason?: string }> {
    const now = new Date();
    const claimed = await this.prisma.clientCadence.updateMany({
      where: {
        clientId: cadenceId,
        OR: [{ dispatchClaimedAt: null }, { dispatchClaimedAt: { lt: new Date(now.getTime() - CLAIM_LEASE_MS) } }],
      },
      data: { dispatchClaimedAt: now },
    });
    if (claimed.count !== 1) return { ok: false, reason: "claimed_elsewhere" };

    const cadence = await this.prisma.clientCadence.findUnique({
      where: { clientId: cadenceId },
      include: {
        tenant: { select: { id: true, name: true, slug: true, timezone: true, rebookingSettings: true } },
      },
    });
    if (!cadence) return { ok: false, reason: "missing" };
    if (cadence.optedOut) return { ok: false, reason: "opted_out" };

    // Re-check enabled flag at the row level too — protects against a stale
    // batch that was loaded before the owner disabled rebooking.
    const cfg = await this.cadence.getTenantConfig(cadence.tenantId);
    if (!cfg.enabled) return { ok: false, reason: "tenant_disabled" };

    const serviceId = cadence.recommendedServiceId;
    if (!serviceId) return { ok: false, reason: "no_recommended_service" };

    // "Time to book your X again" for a service the salon no longer offers
    // sends her to a page that cannot book it. Nothing is recorded or
    // advanced: if the salon turns it back on, the reminder goes out then.
    const recommended = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: { isActive: true },
    });
    if (recommended?.isActive === false) return { ok: false, reason: "service_inactive" };

    // One notice per visit cycle: after a notice for this service, the
    // client is eligible again once she has completed it again since.
    const reminderSentFor = (cadence.reminderSentFor as any[]) ?? [];
    const lastSentForService = reminderSentFor
      .filter((r) => r.serviceId === serviceId && r.sentAt)
      .map((r) => new Date(r.sentAt))
      .sort((a, b) => b.getTime() - a.getTime())[0];
    if (
      lastSentForService &&
      !(await this.completedSince(cadence.tenantId, cadence.clientId, serviceId, lastSentForService))
    ) {
      return { ok: false, reason: "already_sent_for_cycle" };
    }

    const existingReminder = await this.prisma.rebookingReminder.findFirst({
      where: {
        clientId: cadence.clientId,
        serviceId,
        status: { in: [RebookStatus.scheduled, RebookStatus.sent] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (
      existingReminder &&
      !(await this.completedSince(
        cadence.tenantId,
        cadence.clientId,
        serviceId,
        existingReminder.sentAt ?? existingReminder.createdAt,
      ))
    ) {
      return { ok: false, reason: "reminder_already_exists" };
    }

    // Already booked (any service, from today on): she is coming in anyway,
    // and the salon can rebook her at the desk. The cadence is left alone;
    // completing that visit recomputes it.
    if (await this.hasUpcomingAppointment(cadence.tenantId, cadence.clientId)) {
      return { ok: false, reason: "has_upcoming_appointment" };
    }

    const byService = (cadence.byService as Record<string, any>) ?? {};
    const stats: CadenceStats | undefined = byService[serviceId];
    if (stats && stats.stdDevDays > stats.avgDays / 2) {
      await this.advanceCycle(cadence.clientId, serviceId, stats, cfg.leadDays);
      return { ok: false, reason: "high_variability" };
    }

    const channel = cfg.channelFallback as RebookChannel;
    const client = (await this.prisma.client.findUnique({
      where: { id: cadence.clientId },
      select: { id: true, firstName: true, email: true, phone: true, status: true },
    })) as RebookClient | null;

    // A commercial message: not to someone who said no, or whose address
    // must not be emailed. Nothing to retry this cycle; her answer is read
    // again on the next one.
    const notAllowed = client ? await this.notAllowedReason(cadence.tenantId, client, channel) : null;
    if (notAllowed) {
      if (stats) await this.advanceCycle(cadence.clientId, serviceId, stats, cfg.leadDays);
      return { ok: false, reason: notAllowed };
    }

    // Failed sends are retried on the next hourly ticks, a few times a day.
    const recentFailures = await this.prisma.rebookingReminder.count({
      where: {
        clientId: cadence.clientId,
        serviceId,
        status: RebookStatus.failed,
        createdAt: { gte: new Date(Date.now() - DAY_MS) },
      },
    });
    if (recentFailures >= MAX_FAILED_SENDS_PER_DAY) {
      if (stats) await this.advanceCycle(cadence.clientId, serviceId, stats, cfg.leadDays);
      return { ok: false, reason: "too_many_failures" };
    }

    const created = await this.prisma.rebookingReminder.create({
      data: {
        tenantId: cadence.tenantId,
        clientId: cadence.clientId,
        serviceId,
        scheduledAt: new Date(),
        channel,
        status: RebookStatus.scheduled,
      },
    });

    const timeZone = cadence.tenant?.timezone || DEFAULT_TIMEZONE;
    const suggestion = this.suggestDate(stats, opts.hasAdvanced, timeZone, now);

    const result = await this.deliver(cadence, client, serviceId, channel, stats, suggestion);
    await this.prisma.rebookingReminder.update({
      where: { id: created.id },
      data: {
        status: result.ok ? RebookStatus.sent : RebookStatus.failed,
        sentAt: result.ok ? new Date() : null,
        // P2A-receptionist-advanced: the date the email proposed, from her
        // own cadence. Basic mode proposes a generic date and stores none.
        proposedSlot: suggestion.fromCadence
          ? { date: localDay(suggestion.date, timeZone), time: suggestion.time }
          : undefined,
      },
    });

    if (result.ok && stats) {
      // The latest notice per service is all the cycle check needs.
      const sentFor = [
        ...reminderSentFor.filter((r) => r.serviceId !== serviceId),
        {
          serviceId,
          sentAt: new Date().toISOString(),
          channel: cfg.channelFallback,
        },
      ];
      await this.prisma.clientCadence.update({
        where: { clientId: cadence.clientId },
        data: { reminderSentFor: sentFor as any },
      });
      await this.advanceCycle(cadence.clientId, serviceId, stats, cfg.leadDays);
    } else if (!result.ok && result.permanent && stats) {
      // Nothing to retry this cycle (no address, channel not wired).
      await this.advanceCycle(cadence.clientId, serviceId, stats, cfg.leadDays);
    }
    return result.ok ? { ok: true } : { ok: false, reason: result.error };
  }

  /**
   * Why this client may not get the reminder on `channel`, or null.
   *
   * Email ("both" is email until WhatsApp is wired): the campaigns' rules --
   * silence is not a no for an existing client (LSSI art. 21.2), a refusal
   * is, and so is an address on the salon's suppression list (hard bounce,
   * complaint, unsubscribe link). WhatsApp: Meta only allows marketing to
   * people who opted in, so there silence is a no.
   */
  private async notAllowedReason(
    tenantId: string,
    client: RebookClient,
    channel: RebookChannel,
  ): Promise<string | null> {
    if (client.status !== "active") return "client_not_active";
    if (channel === "whatsapp") {
      const accepted = await clientsWhoAcceptedWhatsAppMarketing(this.prisma, tenantId, [client.id]);
      return accepted.has(client.id) ? null : "no_whatsapp_marketing_consent";
    }
    const refused = await clientsWhoRefusedMarketing(this.prisma, tenantId, [client.id]);
    if (refused.has(client.id)) return "marketing_refused";
    const email = realEmail(client.email);
    if (email) {
      const suppressed = await this.suppressions.suppressedAmong(tenantId, [email]);
      if (suppressed.has(email.toLowerCase())) return "email_suppressed";
    }
    return null;
  }

  /** Has the client completed this service after `since`? */
  private async completedSince(
    tenantId: string,
    clientId: string,
    serviceId: string,
    since: Date,
  ): Promise<boolean> {
    const visit = await this.prisma.appointment.findFirst({
      where: {
        tenantId,
        clientId,
        serviceId,
        status: AppointmentStatus.completed,
        completionTime: { gt: since },
      },
      select: { id: true },
    });
    return !!visit;
  }

  /** A pending or confirmed appointment that has not started yet. */
  private async hasUpcomingAppointment(tenantId: string, clientId: string): Promise<boolean> {
    const now = new Date();
    const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    const upcoming = await this.prisma.appointment.findFirst({
      where: {
        tenantId,
        clientId,
        status: { in: [AppointmentStatus.pending, AppointmentStatus.confirmed] },
        OR: [
          { startTime: { gt: now } },
          // Rows without the instant: by their calendar day.
          { startTime: null, scheduledDate: { gte: todayUtc } },
        ],
      },
      select: { id: true },
    });
    return !!upcoming;
  }

  private async advanceCycle(
    clientId: string,
    serviceId: string,
    stats: { avgDays: number; stdDevDays: number },
    leadDays: number,
  ) {
    const nextExpectedAt = new Date(Date.now() + stats.avgDays * DAY_MS);
    const nextReminder = new Date(nextExpectedAt.getTime() - leadDays * DAY_MS);
    await this.prisma.clientCadence.update({
      where: { clientId },
      data: {
        nextRecommendedReminderAt: nextReminder,
        recommendedServiceId: serviceId,
      },
    });
  }

  /**
   * The date the email proposes. With the advanced feature and enough
   * history: her last visit plus her usual cycle (P2A-receptionist-advanced),
   * at 18:30, the most common rebooking window. Otherwise three days ahead
   * at 10:00. Never today or earlier: a reminder sent late (overdue window)
   * or to a client already past her cycle used to propose a day gone by.
   */
  private suggestDate(
    stats: CadenceStats | undefined,
    hasAdvanced: boolean,
    timeZone: string,
    now: Date,
  ): { date: Date; time: string; fromCadence: boolean } {
    const tomorrow = new Date(now.getTime() + DAY_MS);
    const lastVisit = stats?.lastVisit ? new Date(stats.lastVisit) : null;
    if (
      hasAdvanced &&
      stats &&
      typeof stats.avgDays === "number" &&
      stats.avgDays > 0 &&
      lastVisit &&
      !Number.isNaN(lastVisit.getTime())
    ) {
      const target = new Date(lastVisit.getTime() + stats.avgDays * DAY_MS);
      const date = localDay(target, timeZone) < localDay(tomorrow, timeZone) ? tomorrow : target;
      return { date, time: "18:30", fromCadence: true };
    }
    return { date: new Date(now.getTime() + 3 * DAY_MS), time: "10:00", fromCadence: false };
  }

  private async deliver(
    cadence: { clientId: string; lastComputedAt: Date | string; tenant?: { name?: string | null; slug?: string | null; timezone?: string | null } | null },
    client: RebookClient | null,
    serviceId: string,
    channel: RebookChannel,
    stats: CadenceStats | undefined,
    suggestion: { date: Date; time: string },
  ): Promise<SendResult> {
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: { name: true, duration: true },
    });
    if (!client || !service) {
      return { ok: false, channel, error: "missing_client_or_service", permanent: true };
    }

    // WhatsApp is not wired yet (Phase 3), so email is the only channel that
    // can deliver: "both" means email today, and the notice only counts as
    // sent when the email went out.
    if (channel === "whatsapp") {
      return { ok: false, channel, error: "whatsapp_not_wired", permanent: true };
    }
    const email = realEmail(client.email);
    if (!email) {
      return { ok: false, channel, error: "no_email", permanent: true };
    }

    const salonName = cadence.tenant?.name || "tu salón";
    const timeZone = cadence.tenant?.timezone || DEFAULT_TIMEZONE;
    const lastVisit = stats?.lastVisit ? new Date(stats.lastVisit) : null;
    const daysSinceLastVisit = this.daysSince(
      lastVisit && !Number.isNaN(lastVisit.getTime()) ? lastVisit : cadence.lastComputedAt,
    );
    // The client's own unsubscribe link, the one campaigns carry: it stops
    // these reminders and the salon's promotions alike.
    const unsubscribe = this.unsubscribes.link({ kind: "c", id: client.id });

    try {
      const sent = await this.emailService.sendEmail({
        to: email,
        // A subject is plain text: not escaped (it used to show "&amp;").
        subject: `¿Reservamos tu próximo ${service.name} en ${salonName}?`,
        html: this.renderEmailBody({
          clientFirstName: client.firstName,
          salonName,
          serviceName: service.name,
          daysSinceLastVisit: String(daysSinceLastVisit),
          suggestedDate: longDayEs(suggestion.date, timeZone),
          suggestedTime: suggestion.time,
          bookingUrl: this.buildBookingUrl(cadence.tenant?.slug ?? undefined, serviceId),
          unsubscribeUrl: unsubscribe.pageUrl,
        }),
        headers: unsubscribe.headers,
      });
      if (!sent?.success) {
        this.logger.warn(`Email rebook failed: ${sent?.error ?? "unknown error"}`);
        return { ok: false, channel, error: sent?.error ?? "email_failed" };
      }
    } catch (err) {
      this.logger.warn(`Email rebook failed: ${(err as Error).message}`);
      return { ok: false, channel, error: (err as Error).message };
    }
    return { ok: true, channel };
  }

  private buildBookingUrl(slug?: string, serviceId?: string): string {
    const base = process.env.FRONTEND_BASE_URL ?? "http://localhost:3000";
    const params = serviceId ? `?service=${encodeURIComponent(serviceId)}` : "";
    return slug ? `${base}/sites/${encodeURIComponent(slug)}/account/new-appointment${params}` : `${base}${params}`;
  }

  private daysSince(date: Date | string): number {
    const d = typeof date === "string" ? new Date(date) : date;
    return Math.max(0, Math.round((Date.now() - d.getTime()) / DAY_MS));
  }

  /**
   * The email. Every value is escaped here: client names come from
   * self-service sign-up and imports, and markup in them would be rendered
   * by the recipient's mail client.
   */
  private renderEmailBody(vars: {
    clientFirstName: string;
    salonName: string;
    serviceName: string;
    daysSinceLastVisit: string;
    suggestedDate: string;
    suggestedTime: string;
    bookingUrl: string;
    unsubscribeUrl: string;
  }): string {
    const v = Object.fromEntries(Object.entries(vars).map(([k, val]) => [k, escapeHtml(val)])) as typeof vars;
    return `<p>Hola ${v.clientFirstName},</p>
<p>Hace ${v.daysSinceLastVisit} días que no te vemos para tu <strong>${v.serviceName}</strong> en ${v.salonName}.</p>
<p>¿Te reservamos el ${v.suggestedDate} a las ${v.suggestedTime}?</p>
<p><a href="${v.bookingUrl}">Reservar ahora</a></p>
<p style="font-size:11px;color:#999">Recibes este email porque eres cliente de ${v.salonName}. Si no quieres recibir más recordatorios ni promociones, <a href="${v.unsubscribeUrl}">date de baja aquí</a>.</p>`;
  }
}
