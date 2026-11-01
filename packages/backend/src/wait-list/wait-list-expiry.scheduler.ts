import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { WaitListService } from './wait-list.service';

/**
 * Closes stale wait-list entries as "expired" (WaitListService.expireStale).
 * Hourly, at :20, so every salon's entries close within an hour of its own
 * midnight. Idempotent: running twice, or on two instances, closes nothing
 * twice.
 */
@Injectable()
export class WaitListExpiryScheduler {
  private readonly logger = new Logger(WaitListExpiryScheduler.name);

  constructor(private readonly waitList: WaitListService) {}

  @Cron('20 * * * *')
  async run(): Promise<number> {
    try {
      const closed = await this.waitList.expireStale();
      if (closed > 0) this.logger.log(`wait-list: ${closed} stale entries expired`);
      return closed;
    } catch (err) {
      this.logger.error(`wait-list expiry failed: ${(err as Error).message}`);
      return 0;
    }
  }
}
