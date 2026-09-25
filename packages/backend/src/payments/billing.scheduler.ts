import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { runUnscoped } from '../common/tenancy/tenant.context';
import { ProductEventsService, PRODUCT_EVENTS } from '../common/telemetry/product-events.service';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const READ_ONLY_DAYS = 30;

/**
 * Trial expiry and read-only archival.
 *
 * This file used to be a no-op `tick()` stub while
 * `docs/billing-plans-rev3.md` §5 and §6 described its daily work in the
 * present tense. The consequence was that nothing ever moved a tenant out
 * of `trialing`: after day 14 `FeatureFlagService` stopped treating them as
 * Pro, they dropped to their stored plan (`esencial` for every self-signup)
 * and kept using it free, indefinitely -- a perpetual free tier the plan
 * document explicitly rules out, and a conversion rate of zero.
 *
 * Both jobs run at 04:00 so they batch with `GracePeriodScheduler`.
 */
@Injectable()
export class BillingScheduler {
  private readonly logger = new Logger(BillingScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: ProductEventsService,
  ) {}

  /**
   * Trials past `trialEnd` become `cancelled` with a 30-day read-only
   * window. The data stays intact and `FeatureGuard` keeps allowing GETs
   * and the CSV/Excel exports, so a tenant that comes back can reactivate
   * without having lost anything.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async expireTrials(): Promise<void> {
    const now = new Date();
    const readOnlyUntil = new Date(now.getTime() + READ_ONLY_DAYS * MS_PER_DAY);

    // Schedulers run outside any request, so there is no tenant context;
    // being explicit documents that crossing tenants here is intended.
    const expired = await runUnscoped(() =>
      this.prisma.tenant.findMany({
        where: {
          subscriptionStatus: 'trialing',
          trialEnd: { lt: now },
          deletedAt: null,
        },
        select: { id: true, name: true, plan: true, trialEnd: true },
      }),
    );

    if (expired.length === 0) return;

    await runUnscoped(() =>
      this.prisma.tenant.updateMany({
        where: { id: { in: expired.map((t) => t.id) }, deletedAt: null },
        data: {
          subscriptionStatus: 'cancelled',
          cancelledAt: now,
          readOnlyUntil,
        },
      }),
    );

    for (const t of expired) {
      this.events.record(PRODUCT_EVENTS.TRIAL_EXPIRED, t.id, { plan: t.plan });
    }

    this.logger.log(
      `Expired ${expired.length} trial(s): ${expired
        .map((t) => `${t.name} (${t.id})`)
        .join(', ')}. Read-only until ${readOnlyUntil.toISOString()}.`,
    );
  }

  /**
   * Records tenants whose 30-day read-only window has closed. Deliberately
   * observation-only: nothing is deleted here. Purging customer data is an
   * explicit, audited action through the SaaS console, not a cron job.
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async archiveStaleReadOnly(): Promise<void> {
    const now = new Date();

    const stale = await runUnscoped(() =>
      this.prisma.tenant.findMany({
        where: {
          subscriptionStatus: { in: ['cancelled', 'suspended'] },
          readOnlyUntil: { lt: now },
          deletedAt: null,
        },
        select: { id: true, name: true, readOnlyUntil: true },
      }),
    );

    if (stale.length === 0) return;

    this.logger.warn(
      `${stale.length} tenant(s) past their read-only window: ${stale
        .map((t) => `${t.name} (${t.id}, since ${t.readOnlyUntil?.toISOString()})`)
        .join(', ')}. Data is untouched; purge only via the SaaS console.`,
    );
  }
}
