import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron } from "@nestjs/schedule";
import { PrismaService } from "../../common/prisma/prisma.service";
import { runUnscoped } from "../../common/tenancy/tenant.context";
import { EmailService } from "../../notifications/services/email.service";
import { MonitoredJob } from "../../common/ops-alerts/ops-alert-sink";
import { DAY_MS, READ_ONLY_DAYS } from "./salon-retention";
import { CourtesyCandidate, courtesyStep } from "./courtesy";

const BATCH = 200;

export interface CourtesyRun {
  warned: string[];
  expired: string[];
  converted: string[];
  failed: string[];
}

/**
 * The end of the console's courtesies (courtesy.ts, audit 8 D6). Daily at
 * 04:20 UTC, after the 04:00 billing jobs and before the 04:40 retention job:
 * - 3 days before the end, the owner is emailed (claimed by
 *   courtesyWarnedAt; a failed email gives the claim back for the next day);
 * - at the end, read-only for READ_ONLY_DAYS like any salon that left
 *   (cancelledAt set, so the figures count it as ended; it never paid, so it
 *   is not paid churn), and the owner is emailed;
 * - a salon that subscribed in Stripe meanwhile loses only the courtesy
 *   fields.
 * Each change is claimed by a conditional update on the courtesyUntil read,
 * so two instances never act twice. No audit row: the audit log needs a
 * user as actor; the log line records it.
 */
@Injectable()
export class CourtesyScheduler {
  private readonly logger = new Logger(CourtesyScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  @Cron("20 4 * * *")
  @MonitoredJob("CourtesyScheduler.daily")
  async daily(): Promise<CourtesyRun> {
    return this.run(new Date());
  }

  async run(now: Date = new Date()): Promise<CourtesyRun> {
    const out: CourtesyRun = { warned: [], expired: [], converted: [], failed: [] };
    const rows: Array<CourtesyCandidate & { name: string }> = await runUnscoped(() =>
      this.prisma.tenant.findMany({
        where: { courtesyUntil: { not: null }, deletedAt: null, anonymizedAt: null },
        select: {
          id: true,
          name: true,
          subscriptionStatus: true,
          stripeSubscriptionId: true,
          courtesyUntil: true,
          courtesyWarnedAt: true,
        },
        orderBy: { courtesyUntil: "asc" },
        take: BATCH,
      }),
    );
    for (const t of rows) {
      const step = courtesyStep(t, now);
      if (!step) continue;
      try {
        if (step === "converted" && (await this.clear(t))) out.converted.push(t.id);
        if (step === "expire" && (await this.expire(t, now))) out.expired.push(t.id);
        if (step === "warn" && (await this.warn(t, now))) out.warned.push(t.id);
      } catch (err) {
        out.failed.push(t.id);
        this.logger.error(`Courtesy ${step} for ${t.id} failed: ${(err as Error).message}`);
      }
    }
    if (out.warned.length || out.expired.length || out.converted.length || out.failed.length) {
      this.logger.log(
        `Courtesy: ${out.warned.length} warned, ${out.expired.length} ended, ${out.converted.length} now paying, ${out.failed.length} failed`,
      );
    }
    return out;
  }

  private async clear(t: CourtesyCandidate): Promise<boolean> {
    const claimed = await runUnscoped(() =>
      this.prisma.tenant.updateMany({
        where: { id: t.id, courtesyUntil: t.courtesyUntil, stripeSubscriptionId: { not: null } },
        data: { courtesyUntil: null, courtesyPlan: null, courtesyWarnedAt: null },
      }),
    );
    return claimed.count === 1;
  }

  private async expire(t: CourtesyCandidate & { name: string }, now: Date): Promise<boolean> {
    const readOnlyUntil = new Date(now.getTime() + READ_ONLY_DAYS * DAY_MS);
    const claimed = await runUnscoped(() =>
      this.prisma.tenant.updateMany({
        where: { id: t.id, courtesyUntil: t.courtesyUntil, subscriptionStatus: "active", stripeSubscriptionId: null },
        data: {
          subscriptionStatus: "cancelled",
          cancelledAt: now,
          readOnlyUntil,
          currentPeriodEnd: now,
          courtesyUntil: null,
          courtesyPlan: null,
          courtesyWarnedAt: null,
          anonymizationWarnedAt: null,
          anonymizationWarnedFor: null,
        },
      }),
    );
    if (claimed.count !== 1) return false;
    this.logger.warn(`Courtesy of ${t.id} ended; read-only until ${readOnlyUntil.toISOString()}`);
    const to = await this.ownerEmail(t.id);
    if (to) {
      await this.email
        .sendAccountReadOnly({ to, tenantName: t.name, reason: "courtesy_ended", readOnlyUntil, billingUrl: `${this.base()}/dashboard/billing` })
        .catch((err) => this.logger.warn(`Courtesy-ended email for ${t.id} not sent: ${(err as Error).message}`));
    }
    return true;
  }

  private async warn(t: CourtesyCandidate & { name: string }, now: Date): Promise<boolean> {
    const claimed = await runUnscoped(() =>
      this.prisma.tenant.updateMany({
        where: { id: t.id, courtesyUntil: t.courtesyUntil, courtesyWarnedAt: null },
        data: { courtesyWarnedAt: now },
      }),
    );
    if (claimed.count !== 1) return false;
    const to = await this.ownerEmail(t.id);
    const sent = to
      ? await this.email.sendCourtesyEnding({
          to,
          tenantName: t.name,
          endsOn: t.courtesyUntil!,
          billingUrl: `${this.base()}/dashboard/billing`,
        })
      : { success: false, error: "no owner email" };
    if (!sent.success && !(sent as { skipped?: boolean }).skipped) {
      await runUnscoped(() =>
        this.prisma.tenant.updateMany({ where: { id: t.id, courtesyWarnedAt: now }, data: { courtesyWarnedAt: null } }),
      );
      throw new Error(`courtesy email not sent: ${sent.error}`);
    }
    return true;
  }

  private async ownerEmail(tenantId: string): Promise<string | null> {
    const owner = await runUnscoped(() =>
      this.prisma.user.findFirst({ where: { tenantId, role: "owner" }, select: { email: true } }),
    );
    return owner?.email ?? null;
  }

  private base(): string {
    return (this.config.get<string>("APP_BASE_URL") || this.config.get<string>("FRONTEND_URL") || "https://app.kiraroom.net").replace(
      /\/+$/,
      "",
    );
  }
}
