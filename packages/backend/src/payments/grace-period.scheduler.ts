import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../common/prisma/prisma.service";
import { EmailService } from "../notifications/services/email.service";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const READ_ONLY_DAYS = 30;

/**
 * Sprint 2 / Workstream 2.2 — daily grace-period expiry cron.
 *
 * Scans for tenants in `past_due` whose `gracePeriodEndsAt` has
 * elapsed and flips them to `suspended`. The Stripe webhook
 * (`payments/webhooks.controller.ts:handleInvoicePaymentFailed`) set
 * the 7-day grace on the first payment failure; this cron enforces
 * the boundary after Stripe's own Smart Retries have been given a
 * chance to recover.
 *
 * Schedule: `@Cron(EVERY_DAY_AT_4AM)` — same hour as
 * `BillingScheduler.expireTrials` so the two daily jobs batch
 * together (one DB connection, one alert window if either fails).
 *
 * The flipped tenant also receives an `sendAccountSuspended` email
 * (the second notification in the T+0 / T+7 cadence — the first one
 * fires from the Stripe webhook at T+0).
 */
@Injectable()
export class GracePeriodScheduler {
  private readonly logger = new Logger(GracePeriodScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async suspendExpiredGraces(): Promise<void> {
    const now = new Date();
    const expired = await this.prisma.tenant.findMany({
      where: {
        subscriptionStatus: "past_due",
        gracePeriodEndsAt: { lt: now },
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        gracePeriodEndsAt: true,
      },
    });

    if (expired.length === 0) return;

    const readOnlyUntil = new Date(now.getTime() + READ_ONLY_DAYS * MS_PER_DAY);
    await this.prisma.tenant.updateMany({
      where: {
        id: { in: expired.map((t) => t.id) },
        deletedAt: null,
      },
      data: {
        subscriptionStatus: "suspended",
        readOnlyUntil,
      },
    });

    this.logger.log(
      `Suspended ${expired.length} tenant(s) past their grace window: ${expired
        .map((t) => `${t.name} (${t.id})`)
        .join(", ")}`,
    );

    // Notify each owner individually. Email failures are logged and
    // skipped — we never re-flip the row even if the email bounces.
    const baseUrl =
      this.config.get<string>("APP_BASE_URL") ||
      this.config.get<string>("FRONTEND_URL") ||
      "https://app.kiraroom.com";
    const updatePaymentUrl = `${baseUrl.replace(/\/+$/, "")}/dashboard/billing`;

    for (const tenant of expired) {
      try {
        const owner = await this.prisma.user.findFirst({
          where: { tenantId: tenant.id, role: "owner" },
          select: { email: true },
        });
        if (!owner?.email) continue;
        await this.email.sendAccountSuspended({
          to: owner.email,
          tenantName: tenant.name,
          gracePeriodEndsAt:
            tenant.gracePeriodEndsAt ?? new Date(now.getTime() - MS_PER_DAY),
          updatePaymentUrl,
        });
      } catch (err) {
        this.logger.error(
          `Failed to send suspended email for ${tenant.name} (${tenant.id}): ${(err as Error).message}`,
        );
      }
    }
  }
}