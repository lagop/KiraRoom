import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AiConversationCounterService } from '../services/ai-conversation-counter.service';

/**
 * Monthly AI fair-use reset cron.
 *
 * Plan v2 caps each salon's AI messages per month. The count lives on
 * `Tenant.aiConversationsUsed` with the month it belongs to
 * (`aiConversationsPeriod`), so a new month already reads as 0 without
 * this job: until November 2026 it was never registered and the count ran
 * from signup. The job zeroes the rows and drops the month's Redis keys;
 * `resetMonthly` is idempotent, so a second run is harmless.
 *
 * Schedule: 00:30 UTC on the 1st, whatever the server's time zone. (It
 * used to fire at local midnight and then check for 00:xx UTC, which on a
 * server in Madrid never matched.)
 */
@Injectable()
export class AiFairUseResetScheduler {
  private readonly logger = new Logger(AiFairUseResetScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly counter: AiConversationCounterService,
  ) {}

  @Cron('30 0 1 * *', { name: 'ai-fair-use-reset', timeZone: 'UTC' })
  async resetForNewMonth(): Promise<void> {
    await this.resetAllTenants();
  }

  async resetAllTenants(now: Date = new Date()): Promise<void> {
    this.logger.log(`Resetting AI fair-use counters for all tenants...`);
    const tenants = await this.prisma.tenant.findMany({
      where: { deletedAt: null },
      select: { id: true },
    });
    let ok = 0;
    let failed = 0;
    for (const t of tenants) {
      try {
        await this.counter.resetMonthly(t.id, now);
        ok++;
      } catch (err) {
        failed++;
        this.logger.error(`Failed to reset AI counter for tenant ${t.id}: ${(err as Error).message}`);
      }
    }
    this.logger.log(`AI fair-use reset complete. ${ok}/${tenants.length} ok, ${failed} failed.`);
  }
}
