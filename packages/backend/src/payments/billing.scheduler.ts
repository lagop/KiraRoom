import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';

/**
 * P2A-billing-scheduler — placeholder.
 *
 * This file was previously empty (0 bytes) and got gitignored in the
 * initial commit. The import was retained in `payments.module.ts` so
 * the module-level type-check failed.
 *
 * Created as a no-op stub during the SEC-1 + SEC-2 hotfix so the
 * hotfix branch compiles. The real billing scheduler (retry of failed
 * Stripe webhooks, prorated invoice aggregation, etc.) will land in a
 * follow-up sprint.
 */
@Injectable()
export class BillingScheduler {
  private readonly logger = new Logger(BillingScheduler.name);

  /** Hourly no-op tick — placeholder for the real cron schedule. */
  @Cron(CronExpression.EVERY_HOUR)
  tick(): void {
    this.logger.debug('BillingScheduler tick (no-op)');
  }
}
