
import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AiConversationCounterService } from '../services/ai-conversation-counter.service';

/**
 * Monthly AI fair-use reset cron.
 *
 * Why it exists: Plan v2 caps Esencial tenants at 500 conversations/month.
 * The cap counter lives on `Tenant.aiConversationsUsed` and resets to 0
 * each cycle.
 *
 * The counter service's `resetMonthly(tenantId)` is idempotent, so a
 * second run in the same window is safe.
 *
 * Schedule: 00:30 UTC on the first of each month. Slightly off the
 * SaaSRetentionScheduler (03:30) and SaaSBillingScheduler (~04:00) to
 * avoid the DB spike window at minute 0.
 */
@Injectable()
export class AiFairUseResetScheduler {
  private readonly logger = new Logger(AiFairUseResetScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly counter: AiConversationCounterService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async resetIfNewMonth(): Promise<void> {
    const now = new Date();
    const isFirstOfMonth = now.getUTCDate() === 1;
    // Cheap pre-check: only the days around midnight on the 1st
    // actually do work. The cron runs every minute in production;
    // we add an hour-window guard to limit it to one run per day.
    const isFirstHourOfDay = now.getUTCHours() === 0;
    if (!isFirstOfMonth || !isFirstHourOfDay) {
      // Cheap noop for non-1st days. The service still has Redis
      // counters with 35d TTL that expire themselves.
      return;
    }
    await this.resetAllTenants();
  }

  async resetAllTenants(): Promise<void> {
    this.logger.log(`Resetting AI fair-use counters for all tenants...`);
    const tenants = await this.prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true, name: true },
    });
    this.logger.log(`Found ${tenants.length} tenants to reset.`);
    let ok = 0;
    let failed = 0;
    for (const t of tenants) {
      try {
        await this.counter.resetMonthly(t.id);
        ok++;
      } catch (err) {
        failed++;
        this.logger.error(
          `Failed to reset AI counter for tenant ${t.id} (${t.name}): ${(err as Error).message}`,
        );
      }
    }
    this.logger.log(`AI fair-use reset complete. ${ok}/${tenants.length} ok, ${failed} failed.`);
  }
}
