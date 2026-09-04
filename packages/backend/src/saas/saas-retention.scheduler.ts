import { Injectable, Logger } from "@nestjs/common";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../common/prisma/prisma.service";

/**
 * Retention cron for SaaS audit-trail tables that can grow without bound.
 *
 * Why this exists: every SaaS-admin impersonation mints a JWT and then,
 * on consume, inserts a `used_impersonation_tokens` row with `jti` as
 * the PK. The JWT itself expires in 60s (IMPERSONATION_TTL_SECONDS)
 * but the consumed-jti rows accumulate forever because nothing
 * previously deleted them. Without a GC, the table grows by 1 row
 * per impersonation event, indefinitely.
 *
 * The 7-day retention horizon is chosen so that:
 *   - The anti-replay guarantee stays valid against any client clock
 *     skew / network replay window (well past the JWT's 60 s TTL).
 *   - Forensic investigations still have a couple of weeks of
 *     jti history to cross-reference against audit_log rows.
 *
 * Runs daily at 03:30 UTC (offset from BillingScheduler at 04:00 so
 * the two crons don't contend for the same DB connection at the same
 * time on busy nights).
 */
@Injectable()
export class SaaSRetentionScheduler {
  private readonly logger = new Logger(SaaSRetentionScheduler.name);
  /** Retention window for consumed impersonation JTIs. */
  static readonly IMPERSONATION_TOKEN_RETENTION_DAYS = 7;

  constructor(private readonly prisma: PrismaService) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async pruneConsumedImpersonationTokens(): Promise<void> {
    const cutoff = new Date(
      Date.now() -
        SaaSRetentionScheduler.IMPERSONATION_TOKEN_RETENTION_DAYS *
          24 *
          60 *
          60 *
          1000,
    );

    const { count } = await this.prisma.usedImpersonationToken.deleteMany({
      where: { consumedAt: { lt: cutoff } },
    });

    if (count > 0) {
      this.logger.log(
        `Pruned ${count} consumed impersonation token(s) older than ${SaaSRetentionScheduler.IMPERSONATION_TOKEN_RETENTION_DAYS} days`,
      );
    }
  }
}