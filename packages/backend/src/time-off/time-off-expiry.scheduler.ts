import { Injectable, Logger } from "@nestjs/common";
import { Cron } from "@nestjs/schedule";
import { TimeOffRequestsService } from "./time-off-requests.service";

/**
 * Closes the time off requests nobody answered before their last day as
 * rejected ("Caducada", TimeOffRequestsService.expireStale), telling the
 * professional. Hourly, at :35, so each salon's close soon after its own
 * midnight. Idempotent: only rows still pending change.
 */
@Injectable()
export class TimeOffExpiryScheduler {
  private readonly logger = new Logger(TimeOffExpiryScheduler.name);

  constructor(private readonly requests: TimeOffRequestsService) {}

  @Cron("35 * * * *")
  async run(): Promise<number> {
    try {
      const closed = await this.requests.expireStale();
      if (closed > 0) this.logger.log(`time off: ${closed} unanswered requests expired`);
      return closed;
    } catch (err) {
      this.logger.error(`time off expiry failed: ${(err as Error).message}`);
      return 0;
    }
  }
}
