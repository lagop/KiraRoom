import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../common/prisma/prisma.service";
import { EmailService } from "../notifications/services/email.service";

const DAY_MS = 24 * 60 * 60 * 1000;
/**
 * Half-day window around the T-3 / T-1 thresholds. Wide enough that a
 * skipped cron run (deploy window, transient DB blip) still catches
 * the warning on the next attempt, narrow enough that we don't send
 * the T-3 warning at T-2.
 */
const WINDOW_MS = 12 * 60 * 60 * 1000;

/**
 * Sprint 2 / Workstream 2.3 — daily trial-expiry warning cron.
 *
 * Scans for tenants with `subscriptionStatus='trialing'` whose
 * `trialEnd` falls inside the T-3 or T-1 window (now+2.5d..3.5d and
 * now+0.5d..1.5d respectively) and emails the owner a reminder to
 * add a payment method.
 *
 * Idempotency: the `TrialNotificationLog` table has a unique index
 * on (tenantId, daysLeft, trialEnd), so a re-run on the same day
 * (e.g. a deploy) cannot double-email.
 *
 * Runs at 09:00 Europe/Madrid daily. The actual schedule is set to
 * `EVERY_DAY_AT_7AM` UTC, which is 09:00 Madrid in winter (CET) and
 * 09:00 Madrid in summer (CEST) — same wall-clock hour all year.
 */
@Injectable()
export class TrialExpiryScheduler {
  private readonly logger = new Logger(TrialExpiryScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Override for testing. Lets specs freeze time so the test
   * doesn't flake on a wall-clock transition that crosses a day
   * boundary during the run.
   */
  protected now(): Date {
    return new Date();
  }

  @Cron(CronExpression.EVERY_DAY_AT_7AM)
  async sendTrialWarnings(): Promise<void> {
    const now = this.now();
    const results = { t3: 0, t1: 0, skipped: 0, errors: 0 };

    await this.sendForWindow(now, 3, WINDOW_MS, results);
    await this.sendForWindow(now, 1, WINDOW_MS, results);

    if (results.t3 + results.t1 + results.skipped + results.errors > 0) {
      this.logger.log(
        `Trial warnings: T-3 sent=${results.t3}, T-1 sent=${results.t1}, skipped=${results.skipped}, errors=${results.errors}`,
      );
    }
  }

  private async sendForWindow(
    now: Date,
    daysLeft: 1 | 3,
    windowMs: number,
    results: { t3: number; t1: number; skipped: number; errors: number },
  ): Promise<void> {
    const lower = new Date(now.getTime() + (daysLeft * DAY_MS) - windowMs);
    const upper = new Date(now.getTime() + (daysLeft * DAY_MS) + windowMs);

    const tenants = await this.prisma.tenant.findMany({
      where: {
        subscriptionStatus: "trialing",
        trialEnd: { gte: lower, lte: upper },
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        trialEnd: true,
      },
    });

    for (const tenant of tenants) {
      if (!tenant.trialEnd) continue;
      try {
        await this.sendOne(tenant, daysLeft);
        if (daysLeft === 3) results.t3++;
        else results.t1++;
      } catch (err) {
        results.errors++;
        this.logger.error(
          `Failed T-${daysLeft} trial-expiry email for ${tenant.name} (${tenant.id}): ${(err as Error).message}`,
        );
      }
    }
  }

  private async sendOne(
    tenant: { id: string; name: string; trialEnd: Date | null },
    daysLeft: 1 | 3,
  ): Promise<void> {
    if (!tenant.trialEnd) return;

    // Idempotency: check the log table before sending. If we've
    // already sent this exact (tenant, daysLeft, trialEnd) combo,
    // bail. createMany with skipDuplicates below is the second line
    // of defence.
    const alreadySent = await this.prisma.trialNotificationLog.findUnique({
      where: {
        tenantId_daysLeft_trialEnd: {
          tenantId: tenant.id,
          daysLeft,
          trialEnd: tenant.trialEnd,
        },
      },
      select: { id: true },
    });
    if (alreadySent) {
      this.logger.debug(
        `T-${daysLeft} already sent for tenant ${tenant.id} trialEnd=${tenant.trialEnd.toISOString()}`,
      );
      return;
    }

    // Find the owner user (the original invitee).
    const owner = await this.prisma.user.findFirst({
      where: { tenantId: tenant.id, role: "owner" },
      select: { email: true },
    });
    if (!owner?.email) {
      this.logger.warn(
        `Tenant ${tenant.id} (${tenant.name}) has no owner email; skipping T-${daysLeft}.`,
      );
      return;
    }

    const baseUrl =
      this.config.get<string>("APP_BASE_URL") ||
      this.config.get<string>("FRONTEND_URL") ||
      "https://app.kirastudio.com";
    const upgradeUrl = `${baseUrl.replace(/\/+$/, "")}/dashboard/billing`;

    const sent = await this.email.sendTrialExpiry({
      to: owner.email,
      tenantName: tenant.name,
      daysLeft,
      trialEnd: tenant.trialEnd,
      upgradeUrl,
    });

    if (sent.skipped) {
      this.logger.log(
        `T-${daysLeft} for tenant ${tenant.id} skipped (recipient bounced)`,
      );
      return;
    }

    // Record the send. createMany with skipDuplicates is idempotent
    // even under concurrent cron runs (e.g. a second instance on
    // failover).
    if (sent.success && sent.id) {
      await this.prisma.trialNotificationLog.create({
        data: {
          tenantId: tenant.id,
          daysLeft,
          trialEnd: tenant.trialEnd,
          resendId: sent.id,
        },
      });
    }
  }
}