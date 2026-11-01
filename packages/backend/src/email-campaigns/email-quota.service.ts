import { Injectable, Logger } from "@nestjs/common";
import { formatCountEs } from "@kira/shared";
import { PrismaService } from "../common/prisma/prisma.service";
import { MarketingEmailPack, PlatformEmailConfigService } from "../platform/platform-email-config.service";
import { EMAIL_MARKETING_MONTHLY_CAP, LEGACY_TO_REV3 } from "../payments/services/subscriptions.service";
import { safeTimeZone } from "../gift-cards/gift-card-expiry";
import { monthStart, salonToday } from "../analytics/analytics-metrics";

/**
 * The monthly cap on marketing emails (owner's decision, 2026-11-02).
 *
 * Every campaign email -- one-shot campaigns and re-engagement ones -- takes
 * one email of the salon's month: Pro 2,000, Empresa 5,000 per billed
 * location (Tenant.maxLocations, the quantity Stripe charges), Esencial none
 * (it has no campaigns; with the email_marketing add-on it gets Pro's). The
 * month is the calendar month on the salon's clock. Transactional emails
 * (reminders, review requests, receipts) never come through here.
 *
 * Once the month's emails are used, the bono de emails (EmailCreditWallet)
 * pays for each one; its emails do not expire, as the message credits do not.
 * With neither left, sending stops: the campaign is paused with the reason,
 * the rest of its list stays pending, and the sender resumes it by itself
 * when there is room again (a new month, or a bono bought).
 *
 * The count is of emails actually sent: a slot is taken right before the
 * send (an atomic conditional UPDATE, so two senders cannot both take the
 * last one) and given back if the provider did not take the email.
 */

type PlanKey = keyof typeof EMAIL_MARKETING_MONTHLY_CAP;

function planKey(plan: string | null | undefined): PlanKey {
  if (!plan) return "esencial";
  const mapped = (LEGACY_TO_REV3 as Record<string, string>)[plan] ?? plan;
  return mapped in EMAIL_MARKETING_MONTHLY_CAP ? (mapped as PlanKey) : "esencial";
}

/** The month's marketing emails for a plan: Empresa per location, the trial as Pro. */
export function marketingEmailCap(
  plan: string | null | undefined,
  opts: { inTrial: boolean; locations?: number | null; addOn?: boolean },
): number {
  let key = opts.inTrial ? "pro" : planKey(plan);
  // Esencial with the email_marketing add-on sends as Pro does.
  if (key === "esencial" && opts.addOn) key = "pro";
  const perLocation = key === "empresa" ? Math.max(1, opts.locations ?? 1) : 1;
  return EMAIL_MARKETING_MONTHLY_CAP[key] * perLocation;
}

/** "YYYY-MM": the month `now` falls in on the salon's clock. */
export function salonMonth(timeZone: string, now: Date = new Date()): string {
  return salonToday(timeZone, now).slice(0, 7);
}

/** "YYYY-MM-DD": the first day of the next month on the salon's clock, when the cap starts again. */
export function nextMonthStart(timeZone: string, now: Date = new Date()): string {
  return monthStart(salonToday(timeZone, now), 1);
}

/** "2026-12-01" -> "1 de diciembre". */
export function spanishDay(day: string): string {
  return new Date(`${day}T00:00:00Z`).toLocaleDateString("es-ES", { day: "numeric", month: "long", timeZone: "UTC" });
}

/** A salon's cap for the month, read once per batch. */
export interface EmailQuotaLimits {
  tenantId: string;
  /** "YYYY-MM" on the salon's clock. */
  month: string;
  cap: number;
  /** "YYYY-MM-DD": when the next month's emails start. */
  resetsOn: string;
}

/** What the campaigns page shows: "te quedan N este mes". */
export interface EmailQuota {
  month: string;
  /** The plan's emails this month. */
  cap: number;
  /** Sent this month against the plan's emails. */
  planSent: number;
  /** Sent this month paid from the bono. */
  packSent: number;
  /** All marketing emails sent this month. */
  sent: number;
  /** The plan's emails left this month. */
  planRemaining: number;
  /** Bought emails left (they do not expire). */
  packRemaining: number;
  /** What can still be sent this month: the plan's left plus the bono's. */
  remaining: number;
  /** "YYYY-MM-DD": when the plan's emails start again. */
  resetsOn: string;
  /** The bono on sale, or null while the platform has not priced it. */
  pack: MarketingEmailPack | null;
}

/** One email's slot: from the plan's month or from the bono. */
export type EmailReservation =
  | { ok: true; tenantId: string; month: string; source: "plan" | "pack" }
  | { ok: false };

/** Why a campaign stopped at the cap, for the card, in Spanish. */
export function capPauseReason(limits: Pick<EmailQuotaLimits, "cap" | "resetsOn">, packOffered: boolean): string {
  const when = spanishDay(limits.resetsOn);
  const bono = packOffered ? ", o antes si compras un bono de emails" : "";
  if (limits.cap <= 0) {
    return `En pausa: tu plan no incluye emails de marketing este mes. Lo que falta se enviará solo el ${when}${bono}.`;
  }
  return (
    `En pausa: este mes ya se han enviado los ${formatCountEs(limits.cap)} emails de marketing de tu plan. ` +
    `Lo que falta sigue pendiente y se enviará solo el ${when}${bono}.`
  );
}

@Injectable()
export class EmailQuotaService {
  private readonly logger = new Logger(EmailQuotaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly platformEmail: PlatformEmailConfigService,
  ) {}

  /** The salon's cap and month now. Makes sure the month's counter row exists. */
  async limits(tenantId: string, now: Date = new Date()): Promise<EmailQuotaLimits> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        plan: true,
        subscriptionStatus: true,
        trialEnd: true,
        maxLocations: true,
        timezone: true,
        tenantAddOns: { where: { status: "active" }, select: { addOn: { select: { unlocks: true } } } },
      },
    });
    const timeZone = safeTimeZone(tenant?.timezone);
    const inTrial =
      tenant?.subscriptionStatus === "trialing" && !!tenant.trialEnd && new Date(tenant.trialEnd).getTime() > now.getTime();
    const addOn = (tenant?.tenantAddOns ?? []).some(
      (row: { addOn?: { unlocks?: unknown } | null }) =>
        Array.isArray(row.addOn?.unlocks) && (row.addOn!.unlocks as unknown[]).includes("email_marketing"),
    );
    const month = salonMonth(timeZone, now);
    await this.prisma.emailMarketingUsage.createMany({ data: [{ tenantId, month }], skipDuplicates: true });
    return {
      tenantId,
      month,
      cap: tenant ? marketingEmailCap(tenant.plan, { inTrial, locations: tenant.maxLocations, addOn }) : 0,
      resetsOn: nextMonthStart(timeZone, now),
    };
  }

  async getQuota(tenantId: string, now: Date = new Date()): Promise<EmailQuota> {
    const limits = await this.limits(tenantId, now);
    const [usage, wallet] = await Promise.all([
      this.prisma.emailMarketingUsage.findUnique({ where: { tenantId_month: { tenantId, month: limits.month } } }),
      this.prisma.emailCreditWallet.findUnique({ where: { tenantId } }),
    ]);
    const planSent = usage?.planSent ?? 0;
    const packSent = usage?.packSent ?? 0;
    const planRemaining = Math.max(0, limits.cap - planSent);
    const packRemaining = Math.max(0, wallet?.creditsRemaining ?? 0);
    return {
      month: limits.month,
      cap: limits.cap,
      planSent,
      packSent,
      sent: planSent + packSent,
      planRemaining,
      packRemaining,
      remaining: planRemaining + packRemaining,
      resetsOn: limits.resetsOn,
      pack: this.platformEmail.marketingPack(),
    };
  }

  /**
   * Takes one email of the month, or else one of the bono. The conditional
   * update is the lock: under the cap, or a credit left, or nothing.
   */
  async reserve(limits: EmailQuotaLimits): Promise<EmailReservation> {
    const { tenantId, month, cap } = limits;
    if (cap > 0) {
      const plan = await this.prisma.emailMarketingUsage.updateMany({
        where: { tenantId, month, planSent: { lt: cap } },
        data: { planSent: { increment: 1 } },
      });
      if (plan.count > 0) return { ok: true, tenantId, month, source: "plan" };
    }
    const pack = await this.prisma.emailCreditWallet.updateMany({
      where: { tenantId, creditsRemaining: { gt: 0 } },
      data: { creditsRemaining: { decrement: 1 }, creditsUsedTotal: { increment: 1 } },
    });
    if (pack.count > 0) {
      await this.prisma.emailMarketingUsage.updateMany({
        where: { tenantId, month },
        data: { packSent: { increment: 1 } },
      });
      return { ok: true, tenantId, month, source: "pack" };
    }
    return { ok: false };
  }

  /** Gives a slot back: the email did not go out. */
  async release(reservation: EmailReservation): Promise<void> {
    if (!reservation.ok) return;
    const { tenantId, month } = reservation;
    if (reservation.source === "plan") {
      await this.prisma.emailMarketingUsage.updateMany({
        where: { tenantId, month, planSent: { gt: 0 } },
        data: { planSent: { decrement: 1 } },
      });
      return;
    }
    await this.prisma.emailCreditWallet.updateMany({
      where: { tenantId },
      data: { creditsRemaining: { increment: 1 }, creditsUsedTotal: { decrement: 1 } },
    });
    await this.prisma.emailMarketingUsage.updateMany({
      where: { tenantId, month, packSent: { gt: 0 } },
      data: { packSent: { decrement: 1 } },
    });
  }

  /** The reason a campaign shows when it stops at the cap. */
  pauseReason(limits: EmailQuotaLimits): string {
    return capPauseReason(limits, this.platformEmail.marketingPack() !== null);
  }

  /** Stops a campaign at the cap: it stays sending (or active), its rest pending. */
  async pause(campaignId: string, limits: EmailQuotaLimits, now: Date = new Date()): Promise<void> {
    await this.prisma.emailCampaign.updateMany({
      where: { id: campaignId, tenantId: limits.tenantId, status: { in: ["sending", "active"] } },
      data: { capPausedAt: now, lastError: this.pauseReason(limits) },
    });
    this.logger.log(`Campaign ${campaignId}: paused at the month's marketing email cap (${limits.cap}, ${limits.month})`);
  }

  /**
   * The campaigns paused at the cap whose salon has room again -- a new
   * month, or a bono bought -- go on: the pause and its reason are cleared,
   * and the sender picks a sending one up in this same run (a re-engagement
   * one at its next daily run).
   */
  async resumePaused(now: Date = new Date()): Promise<number> {
    const paused = await this.prisma.emailCampaign.findMany({
      where: { capPausedAt: { not: null }, status: { in: ["sending", "active"] } },
      select: { id: true, tenantId: true },
      take: 200,
    });
    const byTenant = new Map<string, string[]>();
    for (const c of paused) byTenant.set(c.tenantId, [...(byTenant.get(c.tenantId) ?? []), c.id]);
    let resumed = 0;
    for (const [tenantId, ids] of byTenant) {
      const quota = await this.getQuota(tenantId, now);
      if (quota.remaining <= 0) continue;
      const out = await this.prisma.emailCampaign.updateMany({
        where: { tenantId, id: { in: ids }, capPausedAt: { not: null } },
        data: { capPausedAt: null, lastError: null },
      });
      resumed += out.count;
      if (out.count > 0) this.logger.log(`Tenant ${tenantId}: ${out.count} campaign(s) resumed, ${quota.remaining} emails left`);
    }
    return resumed;
  }
}
