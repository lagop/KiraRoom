import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { AccountingService } from "./accounting.service";

/**
 * Retries invoices whose push to Holded failed for a transient reason
 * (Holded down, timeout, rate limit). The backoff and the give-up rule live
 * in AccountingService.retryDue; this only sets the pace.
 *
 * Before this existed the "retry queue" was a button that drained every
 * salon's queue, reachable by any owner. Retrying is now automatic and the
 * button only touches the salon's own invoices.
 */
@Injectable()
export class AccountingScheduler {
  private readonly logger = new Logger(AccountingScheduler.name);
  private running = false;

  constructor(private readonly accounting: AccountingService) {}

  @Cron(CronExpression.EVERY_10_MINUTES)
  async retryPending(): Promise<void> {
    // A slow Holded can make one run outlast the interval.
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.accounting.retryDue();
      if (r.retried || r.gaveUp) {
        this.logger.log(
          `Holded retries: ${r.retried} retried, ${r.synced} synced, ${r.gaveUp} gave up, ${r.notDue} not due`,
        );
      }
    } catch (err) {
      this.logger.error(`Holded retry run failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
