
import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AiFairUseAction } from '@prisma/client';
import { SubscriptionsService } from '../../payments/services/subscriptions.service';
import { MetricsService, COUNTERS } from '../../common/observability/metrics.service';

export interface FairUseDecision {
  allowed: boolean;
  reason: 'ok' | 'no_plan' | 'cap_exceeded';
  capSource: 'plan' | 'unlimited' | 'addon';
  cap: number | null;
  used: number;
  fairUseAction: AiFairUseAction;
}

/**
 * Count and gate AI conversations per tenant per month (Plan v2).
 *
 * Source of truth: `Tenant.aiConversationsUsed` (Postgres). Updated
 * with an atomic `UPDATE ... SET aiConversationsUsed = aiConversationsUsed + 1`
 * so the increment is correct under concurrent LLM calls.
 *
 * Cache layer: a Redis INCR shadowed by the same key shape
 * (`vrm:ai:cnt:{tenantId}:{YYYY-MM}`) so 99 % of decisions don't
 * touch Postgres. When Redis is unavailable the service degrades to
 * Postgres-only with no correctness loss (just lower throughput).
 *
 * IMPORTANT: this counter increments ONLY when the orchestrator
 * confirms it will make an LLM call. A conversation that the FAQ
 * cache fully resolves never bumps the counter -- that is the
 * "ahorro masivo" we already shipped in v1.
 */

@Injectable()
export class AiConversationCounterService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiConversationCounterService.name);
  private redis: RedisClientType | null = null;
  private redisAvailable = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly subs: SubscriptionsService,
    private readonly metrics: MetricsService,
  ) {}

  async onModuleInit(): Promise<void> {
    try {
      const url =
        this.config.get<string>('REDIS_URL') ||
        (this.config.get<string>('REDIS_HOST')
          ? `redis://${this.config.get<string>('REDIS_HOST')}:${this.config.get<string>('REDIS_PORT') ?? 6379}`
          : null);
      if (!url) {
        this.logger.warn('AiConversationCounter: no Redis configured, Postgres-only mode.');
        return;
      }
      this.redis = createClient({ url }) as RedisClientType;
      this.redis.on('error', (e) => {
        this.logger.warn(`AiConversationCounter redis error: ${e.message}`);
        this.redisAvailable = false;
      });
      await this.redis.connect();
      this.redisAvailable = true;
      this.logger.log('AiConversationCounter: Redis cache connected.');
    } catch (e) {
      this.logger.warn(
        `AiConversationCounter: Redis unavailable, Postgres-only mode (${(e as Error).message}).`,
      );
      this.redis = null;
      this.redisAvailable = false;
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis) {
      try {
        await this.redis.quit();
      } catch {
        /* ignore */
      }
    }
  }


  /** Returns the effective cap for the tenant (null = unlimited). */
  async getEffectiveCap(tenantId: string): Promise<number | null> {
    const ctx = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        plan: true,
        tenantAddOns: {
          where: { status: 'active' },
          select: { addOn: { select: { key: true } } },
        },
      },
    });
    if (!ctx) return null;
    const hasAiExpansion = ctx.tenantAddOns.some(
      (a) => a.addOn?.key === 'ai_expansion',
    );
    return this.subs.resolveEffectiveAiCap(ctx.plan, hasAiExpansion);
  }

  /** Returns the configured fair-use action for the tenant. */
  async getFairUseAction(tenantId: string): Promise<AiFairUseAction> {
    const ctx = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { aiFairUseAction: true },
    });
    return ctx?.aiFairUseAction ?? 'degrade';
  }

  /**
   * Cheap selector used to label cap-hit counter increments. Falls
   * back to 'unknown' so the label cardinality stays bounded.
   */
  private async getPlanLabel(tenantId: string): Promise<string> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { plan: true },
    });
    return t?.plan ?? 'unknown';
  }

  /**
   * Reads the current usage counter.
   *
   * Tries Redis first. Falls back to Postgres on cache miss OR Redis
   * unavailability. Source of truth is always Postgres.
   */
  async getUsage(tenantId: string): Promise<number> {
    if (this.redisAvailable && this.redis) {
      try {
        const yyyymm = currentYearMonth();
        const key = `vrm:ai:cnt:${tenantId}:${yyyymm}`;
        const cached = await this.redis.get(key);
        if (cached !== null) return Number(cached);
      } catch (e) {
        this.logger.warn(`getUsage Redis miss: ${(e as Error).message}`);
      }
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { aiConversationsUsed: true },
    });
    return tenant?.aiConversationsUsed ?? 0;
  }


  /**
   * Atomic increment. Returns the new counter value.
   *
   * Strategy: try Redis INCR first (O(1)), then asynchronously sync
   * to Postgres with an atomic UPDATE. The Postgres update is the
   * source of truth. If Redis is down or slow, the Postgres write
   * still wins and the next read will see the right value.
   *
   * For plans with cap=null we skip the counter altogether (no
   * reason to track Pro/Enterprise usage beyond observability).
   */
  async increment(tenantId: string): Promise<{ newCount: number; cappedBy: number | null }> {
    const cap = await this.getEffectiveCap(tenantId);
    if (cap === null) {
      return { newCount: 0, cappedBy: null };
    }
    const yyyymm = currentYearMonth();
    const redisKey = `vrm:ai:cnt:${tenantId}:${yyyymm}`;
    let newCount = 0;

    if (this.redisAvailable && this.redis) {
      try {
        const r = await this.redis.incr(redisKey);
        // Set TTL on first write so the key expires naturally even if
        // the monthly reset cron fails.
        await this.redis.expire(redisKey, 35 * 24 * 60 * 60);
        newCount = Number(r);
      } catch (e) {
        this.logger.warn(`Redis INCR failed: ${(e as Error).message}`);
      }
    }

    try {
      const updated = await this.prisma.tenant.update({
        where: { id: tenantId },
        data: { aiConversationsUsed: { increment: 1 } },
        select: { aiConversationsUsed: true },
      });
      if (newCount === 0) newCount = updated.aiConversationsUsed;
      // Align Redis if it under-reported (cache miss path).
      if (this.redisAvailable && this.redis && newCount !== updated.aiConversationsUsed) {
        await this.redis.set(redisKey, String(updated.aiConversationsUsed));
      }
    } catch (e) {
      this.logger.error(
        `Postgres increment failed for tenant ${tenantId}: ${(e as Error).message}`,
      );
    }

    return { newCount, cappedBy: cap };
  }


  /**
   * The gate called before any LLM invocation.
   *
   * - allowed=true  -> orchestrator proceeds with the LLM call
   *                    and then calls increment().
   * - allowed=false -> orchestrator must short-circuit. Behaviour
   *                    depends on fairUseAction:
   *   * degrade -> skip the LLM, answer from FAQ cache + handoff.
   *   * notify  -> allow the LLM this once, mark ai_fair_use_alert.
   *   * allow   -> allow without surfacing anything to the tenant.
   */
  async evaluate(tenantId: string): Promise<FairUseDecision> {
    const cap = await this.getEffectiveCap(tenantId);
    if (cap === null) {
      this.metrics.counter(COUNTERS.AI_CALLS, 'AI conversation outcomes by status').inc({ status: 'unlimited' });
      return {
        allowed: true,
        reason: 'ok',
        capSource: 'unlimited',
        cap: null,
        used: 0,
        fairUseAction: 'degrade',
      };
    }
    const used = await this.getUsage(tenantId);
    const action = await this.getFairUseAction(tenantId);

    if (used < cap) {
      this.metrics.counter(COUNTERS.AI_CALLS, 'AI conversation outcomes by status').inc({ status: 'success' });
      return {
        allowed: true,
        reason: 'ok',
        capSource: 'plan',
        cap,
        used,
        fairUseAction: action,
      };
    }

    // used >= cap: apply the configured behaviour.
    if (action === 'allow') {
      this.metrics.counter(COUNTERS.AI_CALLS, 'AI conversation outcomes by status').inc({ status: 'success' });
      return {
        allowed: true,
        reason: 'ok',
        capSource: 'plan',
        cap,
        used,
        fairUseAction: action,
      };
    }
    // Plan label for the cap-hit counter. The plan field is a string;
    // we report whatever the data has (esencial / pro / empresa).
    const planLabel = await this.getPlanLabel(tenantId);
    this.metrics.counter(COUNTERS.AI_FAIRUSE_CAP_HIT, 'AI fair-use cap hit by plan (cap_exceeded path)').inc({ plan: planLabel });
    return {
      allowed: false,
      reason: 'cap_exceeded',
      capSource: 'plan',
      cap,
      used,
      fairUseAction: action,
    };
  }

  /** Resets the counter for a tenant (called by the monthly scheduler). */
  async resetMonthly(tenantId: string): Promise<void> {
    const now = new Date();
    const next = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        aiConversationsUsed: 0,
        aiConversationsResetAt: next,
      },
    });
    // Drop this month's Redis key so the next call reads from
    // Postgres and stays consistent.
    if (this.redisAvailable && this.redis) {
      try {
        await this.redis.del(`vrm:ai:cnt:${tenantId}:${currentYearMonth(now)}`);
      } catch {
        /* ignore */
      }
    }
  }
}

function currentYearMonth(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
