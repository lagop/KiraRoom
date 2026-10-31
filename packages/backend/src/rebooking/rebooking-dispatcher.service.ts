import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../common/prisma/prisma.service";
import { ClientCadenceService } from "./client-cadence.service";
import { AppointmentStatus, RebookChannel, RebookStatus } from "@prisma/client";
import { FeatureFlagService } from "../common/feature-flags/feature-flag.service";
import { EmailService } from "../notifications/services/email.service";
import { realEmail } from "../common/placeholder-email";
import { createHmac } from "crypto";

interface SendResult {
  ok: boolean;
  channel: RebookChannel;
  error?: string;
  /** Retrying cannot help (no address, channel not wired): skip this cycle. */
  permanent?: boolean;
}

const CRON_BATCH_SIZE = 500;
const CRON_PARALLEL_TENANTS = 8;
/** Failed sends for one client and service in a day before the cycle is skipped. */
const MAX_FAILED_SENDS_PER_DAY = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

function escapeHtml(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function resolveOptOutSecret(): string {
  const secret = process.env.REBOOKING_OPT_OUT_SECRET;
  if (secret && secret.length >= 16) return secret;
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "REBOOKING_OPT_OUT_SECRET must be set (>=16 chars) in production",
    );
  }
  // Dev/test only — explicit warning so it never silently ships.
  // eslint-disable-next-line no-console
  console.warn(
    "[rebooking] REBOOKING_OPT_OUT_SECRET is unset; using insecure dev fallback. " +
      "Do NOT deploy this build to production.",
  );
  return "dev-secret-do-not-use-in-production";
}

@Injectable()
export class RebookingDispatcherService implements OnModuleInit {
  private readonly logger = new Logger(RebookingDispatcherService.name);
  private optOutSecret!: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly cadence: ClientCadenceService,
    private readonly emailService: EmailService,
    private readonly flags: FeatureFlagService,
  ) {}

  onModuleInit(): void {
    // Validate the secret eagerly so a misconfigured prod deploy fails fast.
    this.optOutSecret = resolveOptOutSecret();
  }

  /**
   * Hourly cron that processes every cadence whose `nextRecommendedReminderAt`
   * falls within the current UTC day. We dispatch per-tenant in bounded
   * parallel batches so a 10k-cadence hour doesn't run sequentially.
   */
  @Cron(CronExpression.EVERY_HOUR)
  async runHourlyTick() {
    return this.runDailyTick();
  }

  /**
   * Public method so tests can bypass the cron decorator and call directly.
   */
  async runDailyTick(): Promise<{ processed: number; sent: number; skipped: number }> {
    const now = new Date();
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);

    // Group candidates by tenant so we can dispatch per-tenant concurrently and
    // respect each tenant's `enabled` / `channelFallback` / `leadDays` in one
    // pass without redundant config reads.
    const cadences = await this.prisma.clientCadence.findMany({
      where: {
        optedOut: false,
        nextRecommendedReminderAt: {
          gte: todayStart,
          lt: tomorrowStart,
        },
      },
      include: {
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
            rebookingSettings: true,
          },
        },
      },
      take: CRON_BATCH_SIZE,
      orderBy: { nextRecommendedReminderAt: "asc" },
    });

    let processed = 0;
    let sent = 0;
    let skipped = 0;

    // Group by tenantId, then dispatch tenants in bounded parallel.
    const byTenant = new Map<string, typeof cadences>();
    for (const c of cadences) {
      const arr = byTenant.get(c.tenantId) ?? [];
      arr.push(c);
      byTenant.set(c.tenantId, arr);
    }
    const tenantIds = [...byTenant.keys()];

    for (let i = 0; i < tenantIds.length; i += CRON_PARALLEL_TENANTS) {
      const slice = tenantIds.slice(i, i + CRON_PARALLEL_TENANTS);
      const results = await Promise.allSettled(
        slice.map((tenantId) =>
          this.processTenantBatch(tenantId, byTenant.get(tenantId)!),
        ),
      );
      for (const r of results) {
        if (r.status === "fulfilled") {
          processed += r.value.processed;
          sent += r.value.sent;
          skipped += r.value.skipped;
        } else {
          skipped++;
          this.logger.warn(
            `Tenant batch failed: ${(r.reason as Error).message}`,
          );
        }
      }
    }

    if (processed > 0) {
      this.logger.log(
        `Rebooking tick: processed=${processed} sent=${sent} skipped=${skipped}`,
      );
    }
    return { processed, sent, skipped };
  }

  private async processTenantBatch(
    tenantId: string,
    rows: Array<{ clientId: string }>,
  ): Promise<{ processed: number; sent: 0 | number; skipped: number }> {
    // Re-check enabled flag at dispatch time — the cadence row may have been
    // computed when the tenant had rebooking enabled, but the owner may have
    // toggled it off afterwards. No work for disabled tenants.
    const cfg = await this.cadence.getTenantConfig(tenantId);
    if (!cfg.enabled) {
      return { processed: rows.length, sent: 0, skipped: rows.length };
    }

    // P2A-receptionist-advanced — "Proactive rescheduling" (advanced mode)
    // is a paid feature. When the tenant doesn't have the advanced flag we
    // silently downgrade to a plain "you should come back" message and skip
    // the AI-curated slot suggestion. The basic reminder (channel-aware)
    // still fires; advanced only adds the "we held a slot for you" copy.
    const hasAdvanced = await this.flags.isFeatureUnlocked(
      tenantId,
      'virtual_receptionist_advanced',
    );
    if (!hasAdvanced) {
      this.logger.log(
        `[rebooking] tenant ${tenantId}: virtual_receptionist_advanced locked; falling back to basic-reminder mode.`,
      );
    }
    let sent = 0;
    let skipped = 0;
    for (const row of rows) {
      try {
        const result = await this.processOne(row.clientId, { hasAdvanced });
        if (result.ok) sent++;
        else skipped++;
      } catch (err) {
        skipped++;
        this.logger.warn(
          `Failed to process cadence ${row.clientId}: ${(err as Error).message}`,
        );
      }
    }
    return { processed: rows.length, sent, skipped };
  }

  /**
   * Process a single cadence: idempotency-check, send, and advance the
   * prediction to the next cycle.
   */
  async processOne(
    cadenceId: string,
    opts: { hasAdvanced: boolean } = { hasAdvanced: true },
  ): Promise<{ ok: boolean; reason?: string }> {
    const cadence = await this.prisma.clientCadence.findUnique({
      where: { clientId: cadenceId },
      include: {
        tenant: { select: { id: true, name: true, slug: true, rebookingSettings: true } },
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
    const stats = byService[serviceId];
    if (stats && stats.stdDevDays > stats.avgDays / 2) {
      await this.advanceCycle(cadence.clientId, serviceId, stats, cfg.leadDays);
      return { ok: false, reason: "high_variability" };
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
        channel: cfg.channelFallback as RebookChannel,
        status: RebookStatus.scheduled,
      },
    });

    // P2A-receptionist-advanced — "Proactive rescheduling" lifts the
    // suggested slot from a generic +3d@10:00 to one derived from the
    // client's own visit cadence (avg cycle +/- half std-dev). For Esencial
    // (or Esencial without ai_expansion) the basic placeholder stays in place.
    const suggestedSlot = opts.hasAdvanced
      ? this.suggestSlotFromCadence(cadence, serviceId, stats)
      : undefined;

    const result = await this.deliver(
      cadence,
      serviceId,
      cfg.channelFallback as RebookChannel,
      suggestedSlot,
    );
    await this.prisma.rebookingReminder.update({
      where: { id: created.id },
      data: {
        status: result.ok ? RebookStatus.sent : RebookStatus.failed,
        sentAt: result.ok ? new Date() : null,
        // Persist the proposed slot so the tenant dashboard can show
        // "we held this for you".
        proposedSlot: suggestedSlot ?? undefined,
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
    const nextExpectedAt = new Date(
      Date.now() + stats.avgDays * 24 * 60 * 60 * 1000,
    );
    const nextReminder = new Date(
      nextExpectedAt.getTime() - leadDays * 24 * 60 * 60 * 1000,
    );
    await this.prisma.clientCadence.update({
      where: { clientId },
      data: {
        nextRecommendedReminderAt: nextReminder,
        recommendedServiceId: serviceId,
      },
    });
  }

  private async deliver(
    cadence: any,
    serviceId: string,
    channel: RebookChannel,
    suggestedSlot?: { date: string; time: string } | undefined,
  ): Promise<SendResult> {
    const client = await this.prisma.client.findUnique({
      where: { id: cadence.clientId },
      select: { id: true, firstName: true, email: true, phone: true },
    });
    const service = await this.prisma.service.findUnique({
      where: { id: serviceId },
      select: { name: true, duration: true },
    });
    if (!client || !service) {
      return { ok: false, channel, error: "missing_client_or_service", permanent: true };
    }

    const daysSinceLastVisit = this.daysSince(cadence.lastComputedAt);
    const optOutUrl = this.buildOptOutUrl(cadence.clientId);
    const bookingUrl = this.buildBookingUrl(cadence.tenant?.slug, serviceId);

    // P2A-receptionist-advanced: when an AI-derived slot was computed
    // (avgDays +/- half-stdev), surface it; otherwise fall back to the
    // "next business day at 10:00" placeholder.
    const dateStr =
      suggestedSlot?.date ??
      new Date(Date.now() + 3 * 24 * 60 * 60 * 1000).toLocaleDateString("es-ES");
    const timeStr = suggestedSlot?.time ?? "10:00";

    // NOTE: every variable interpolated into the HTML template below is
    // escaped via `escapeHtml()`. Do NOT remove the escape calls — client
    // names come from self-service signup and are an XSS sink in the
    // recipient's mail client.
    const vars = {
      clientFirstName: escapeHtml(client.firstName),
      salonName: escapeHtml(cadence.tenant?.name ?? ""),
      serviceName: escapeHtml(service.name),
      daysSinceLastVisit: escapeHtml(String(daysSinceLastVisit)),
      suggestedDate: escapeHtml(dateStr),
      suggestedTime: escapeHtml(timeStr),
      bookingUrl: escapeHtml(bookingUrl),
      optoutUrl: escapeHtml(optOutUrl),
    };

    // WhatsApp is not wired yet (Phase 3), so email is the only channel that
    // can deliver: "both" means email today, and the notice only counts as
    // sent when the email went out. It used to be marked sent regardless
    // (no address, provider error, WhatsApp-only), which used up the cycle.
    if (channel === "whatsapp") {
      return { ok: false, channel, error: "whatsapp_not_wired", permanent: true };
    }
    const email = realEmail(client.email);
    if (!email) {
      return { ok: false, channel, error: "no_email", permanent: true };
    }
    try {
      const sent = await this.emailService.sendEmail({
        to: email,
        subject: `¿Listo para tu próximo ${vars.serviceName}?`,
        html: this.renderEmailBody(vars),
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

  private buildOptOutUrl(clientId: string): string {
    const token = createHmac("sha256", this.optOutSecret)
      .update(clientId)
      .digest("hex")
      .slice(0, 32);
    const base = process.env.FRONTEND_BASE_URL ?? "http://localhost:3000";
    return `${base}/api/public/rebooking/opt-out?token=${token}&client=${clientId}`;
  }

  private buildBookingUrl(slug?: string, serviceId?: string): string {
    const base = process.env.FRONTEND_BASE_URL ?? "http://localhost:3000";
    const params = serviceId ? `?service=${serviceId}` : "";
    return slug ? `${base}/sites/${slug}/account/new-appointment${params}` : `${base}${params}`;
  }

  private daysSince(date: Date | string): number {
    const d = typeof date === "string" ? new Date(date) : date;
    return Math.max(0, Math.round((Date.now() - d.getTime()) / (1000 * 60 * 60 * 24)));
  }

  /**
   * P2A-receptionist-advanced — derive a promising suggested slot from
   * the cadence stats when we have enough history. Returns undefined
   * when stats are missing or too noisy (callers fall back to the
   * "next business day +3d" placeholder).
   *
   * Algorithm:
   *   - target_date = lastComputedAt + avgDays +/- half std-dev
   *   - target_time = 18:30 (after work hours, the most common rebook
   *     window for beauty/salon services) — would be better per-tenant
   *     once we collect hour-of-day history.
   */
  private suggestSlotFromCadence(
    cadence: any,
    serviceId: string,
    stats: { avgDays?: number; stdDevDays?: number } | undefined,
  ): { date: string; time: string } | undefined {
    if (!stats || typeof stats.avgDays !== "number" || stats.avgDays <= 0) {
      return undefined;
    }
    const anchor = cadence.lastComputedAt
      ? typeof cadence.lastComputedAt === "string"
        ? new Date(cadence.lastComputedAt)
        : cadence.lastComputedAt
      : new Date(Date.now() - stats.avgDays * 24 * 60 * 60 * 1000);
    const jitter =
      typeof stats.stdDevDays === "number"
        ? Math.min(stats.stdDevDays, 7) * 24 * 60 * 60 * 1000 / 2
        : 0;
    const offset = (Math.random() * 2 - 1) * jitter;
    const target = new Date(
      anchor.getTime() + stats.avgDays * 24 * 60 * 60 * 1000 + offset,
    );
    return {
      date: target.toLocaleDateString("es-ES"),
      time: "18:30",
    };
  }

  private renderEmailBody(vars: Record<string, string>): string {
    return `<p>Hola ${vars.clientFirstName},</p>
<p>Hace ${vars.daysSinceLastVisit} días que no te vemos para tu <strong>${vars.serviceName}</strong> en ${vars.salonName}.</p>
<p>¿Te reservamos el ${vars.suggestedDate} a las ${vars.suggestedTime}?</p>
<p><a href="${vars.bookingUrl}">Reservar ahora</a></p>
<p style="font-size:11px;color:#999">Si no quieres recibir más recordatorios, <a href="${vars.optoutUrl}">cancela la suscripción</a>.</p>`;
  }
}