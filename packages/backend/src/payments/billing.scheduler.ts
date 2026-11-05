import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../common/prisma/prisma.service';
import { runUnscoped } from '../common/tenancy/tenant.context';
import { ProductEventsService, PRODUCT_EVENTS } from '../common/telemetry/product-events.service';
import { ReadOnlyNoticeService } from './read-only-notice.service';
import { MonitoredJob } from "../common/ops-alerts/ops-alert-sink";

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
 * The read-only archival runs at 04:00 so it batches with
 * `GracePeriodScheduler`. Trial expiry runs every hour (B9): a trial ends at
 * the exact time of the signup, and with a daily run the salon spent up to
 * a day still `trialing` but no longer Pro, writable and without either
 * banner.
 */
@Injectable()
export class BillingScheduler {
  private readonly logger = new Logger(BillingScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly events: ProductEventsService,
    private readonly notices: ReadOnlyNoticeService,
  ) {}

  /**
   * Trials past `trialEnd` become `cancelled` with a 30-day read-only
   * window. The data stays intact and `FeatureGuard` keeps allowing GETs
   * and the CSV/Excel exports, so a tenant that comes back can reactivate
   * without having lost anything.
   *
   * Each tenant is flipped by its own conditional update (still
   * `trialing`), and only the ones this run flipped get the email: a second
   * run, or a plan bought in between, sends nothing.
   *
   * A salon that subscribed during its trial kept the trial (Pro) until its
   * end with its Stripe subscription already in place (see liveStatusFor):
   * it becomes `active` instead, on the plan it pays for. Stripe's own
   * webhook usually gets there first; this covers the last-two-days case,
   * where Stripe was already charging, and a webhook that never arrived.
   * If that subscription was cancelled at the end of its period and the
   * end has passed, the salon is cancelled instead (B11): the webhook for
   * the end of the subscription was lost, and making it active would give
   * the plan away for good.
   *
   * Hourly rather than daily (B9). Running it hourly is safe: every change
   * is a conditional update on `trialing`, so overlapping or repeated runs
   * neither flip a salon twice nor email it twice. Handling "trialing with
   * a past trialEnd" in the guards and the panel instead would mean
   * teaching every reader of the status (guards, feature flags, limits,
   * the panel) a second meaning of `trialing`; keeping one transition in
   * one place leaves at most an hour of slack.
   */
  @Cron(CronExpression.EVERY_HOUR)
  @MonitoredJob("BillingScheduler.expireTrials")
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
        select: {
          id: true,
          name: true,
          plan: true,
          trialEnd: true,
          stripeSubscriptionId: true,
          subscriptionCancelAt: true,
        },
      }),
    );

    if (expired.length === 0) return;

    const flipped: typeof expired = [];
    for (const t of expired) {
      if (t.stripeSubscriptionId && t.subscriptionCancelAt && t.subscriptionCancelAt <= now) {
        const { count } = await runUnscoped(() =>
          this.prisma.tenant.updateMany({
            where: { id: t.id, subscriptionStatus: 'trialing', deletedAt: null },
            data: {
              subscriptionStatus: 'cancelled',
              cancelledAt: now,
              subscriptionCancelAt: null,
              readOnlyUntil,
            },
          }),
        );
        if (count === 1) {
          this.logger.warn(
            `Trial of ${t.name} (${t.id}) ended with its subscription ${t.stripeSubscriptionId} cancelled at ${t.subscriptionCancelAt.toISOString()} and no webhook for it: cancelled`,
          );
          await this.notices.notify(t.id, 'cancelled', readOnlyUntil);
        }
        continue;
      }
      if (t.stripeSubscriptionId) {
        const { count } = await runUnscoped(() =>
          this.prisma.tenant.updateMany({
            where: { id: t.id, subscriptionStatus: 'trialing', deletedAt: null },
            data: { subscriptionStatus: 'active' },
          }),
        );
        if (count === 1) {
          this.logger.log(`Trial of ${t.name} (${t.id}) ended with a paid subscription: active on ${t.plan}`);
        }
        continue;
      }
      const { count } = await runUnscoped(() =>
        this.prisma.tenant.updateMany({
          where: { id: t.id, subscriptionStatus: 'trialing', deletedAt: null },
          data: {
            subscriptionStatus: 'cancelled',
            cancelledAt: now,
            readOnlyUntil,
          },
        }),
      );
      if (count === 1) flipped.push(t);
    }
    if (flipped.length === 0) return;

    for (const t of flipped) {
      this.events.record(PRODUCT_EVENTS.TRIAL_EXPIRED, t.id, { plan: t.plan });
    }

    this.logger.log(
      `Expired ${flipped.length} trial(s): ${flipped
        .map((t) => `${t.name} (${t.id})`)
        .join(', ')}. Read-only until ${readOnlyUntil.toISOString()}.`,
    );

    for (const t of flipped) {
      await this.notices.notify(t.id, 'trial_ended', readOnlyUntil);
    }
  }

  /**
   * Records tenants whose 30-day read-only window has closed. Observation
   * only: the owner is warned and the data anonymised 30 days later by the
   * retention job (saas/retention/salon-retention.scheduler.ts).
   */
  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  @MonitoredJob("BillingScheduler.archiveStaleReadOnly")
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
        .join(', ')}. Data is anonymised 30 days later by the retention job (the console switch Retención de datos).`,
    );
  }
}
