
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient, RedisClientType } from 'redis';
import { PrismaService } from '../../common/prisma/prisma.service';
import { AiFairUseAction } from '@prisma/client';
import { SubscriptionsService } from '../../payments/services/subscriptions.service';
import { MetricsService, COUNTERS } from '../../common/observability/metrics.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { AI_PACK_ADDON_KEYS, aiDailyCap } from '@kira/shared';

export interface FairUseDecision {
  allowed: boolean;
  reason: 'ok' | 'no_plan' | 'cap_exceeded' | 'daily_cap_exceeded';
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
    @Optional() private readonly notifications?: NotificationsService,
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


  /**
   * The month's AI message cap for the tenant: 500 in the trial, else the
   * plan's (Empresa: per location) plus 1,000 per AI pack. Never unlimited:
   * each message is a paid model call. null only for an unknown tenant.
   */
  async getEffectiveCap(tenantId: string): Promise<number | null> {
    const ctx = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        plan: true,
        subscriptionStatus: true,
        trialEnd: true,
        maxLocations: true,
        tenantAddOns: {
          where: { status: 'active' },
          select: { addOn: { select: { key: true } } },
        },
      },
    });
    if (!ctx) return null;
    const packs = (ctx.tenantAddOns ?? []).filter((a) => AI_PACK_ADDON_KEYS.has(a.addOn?.key ?? '')).length;
    const inTrial =
      ctx.subscriptionStatus === 'trialing' &&
      !!ctx.trialEnd &&
      ctx.trialEnd.getTime() > Date.now();
    return this.subs.aiCap(ctx.plan, { inTrial, locations: ctx.maxLocations, packs });
  }

  /** AI messages the tenant has used today (UTC). */
  async getDailyUsage(tenantId: string): Promise<number> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { aiMessagesToday: true, aiMessagesDay: true },
    });
    return t?.aiMessagesDay === currentDay() ? (t.aiMessagesToday ?? 0) : 0;
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
   * Also counts the day, for the daily cap.
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

    // Today's count: one atomic statement, restarting at 1 on a new day.
    try {
      const day = currentDay();
      await this.prisma.$executeRaw`
        UPDATE "tenants"
        SET "aiMessagesToday" = CASE WHEN "aiMessagesDay" = ${day} THEN "aiMessagesToday" + 1 ELSE 1 END,
            "aiMessagesDay" = ${day}
        WHERE "id" = ${tenantId}`;
    } catch (e) {
      this.logger.error(`Daily AI count failed for tenant ${tenantId}: ${(e as Error).message}`);
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
    const today = await this.getDailyUsage(tenantId);
    const dailyCap = aiDailyCap(cap);
    const action = await this.getFairUseAction(tenantId);
    const reason = used >= cap ? 'cap_exceeded' : 'daily_cap_exceeded';

    if (used < cap && today < dailyCap) {
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
    void this.notifyCapReached(tenantId, reason, reason === 'cap_exceeded' ? cap : dailyCap).catch((e: Error) =>
      this.logger.warn(`AI cap notice not sent for tenant ${tenantId}: ${e.message}`),
    );
    return {
      allowed: false,
      reason,
      capSource: 'plan',
      cap,
      used,
      fairUseAction: action,
    };
  }

  /**
   * Tells the salon's owners and admins, once a day, that the receptionist
   * hit a cap and is handing conversations to the team. Without it the
   * salon only found out from its clients.
   */
  private async notifyCapReached(
    tenantId: string,
    reason: 'cap_exceeded' | 'daily_cap_exceeded',
    limit: number,
  ): Promise<void> {
    if (!this.notifications) return;
    const day = currentDay();
    // Claim today's notice; a concurrent refusal finds it taken.
    const claimed = await this.prisma.tenant.updateMany({
      where: { id: tenantId, OR: [{ aiCapNotifiedOn: null }, { aiCapNotifiedOn: { not: day } }] },
      data: { aiCapNotifiedOn: day },
    });
    if (claimed.count === 0) return;

    const managers = await this.prisma.user.findMany({
      where: { tenantId, role: { in: ['owner', 'admin'] }, isActive: true },
      select: { id: true },
    });
    const limitText = limit.toLocaleString('es-ES');
    const title = 'Tu recepcionista IA ha llegado a su límite';
    const message =
      reason === 'cap_exceeded'
        ? `Has usado los ${limitText} mensajes de IA de este mes. Hasta que empiece el mes que viene, la recepcionista pasa las conversaciones a tu equipo. Puedes añadir 1.000 mensajes más por 19 €/mes en Facturación.`
        : `Hoy se han usado ${limitText} mensajes de IA, el máximo de un día. Hasta mañana la recepcionista pasa las conversaciones a tu equipo. Si no reconoces tanto uso, revisa las conversaciones.`;
    for (const m of managers) {
      await this.notifications.create({
        tenantId,
        userId: m.id,
        type: 'system_alert' as any,
        title,
        message,
        data: { kind: 'ai_cap', reason, limit, url: '/dashboard/billing' },
      });
    }
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

/** Today as YYYY-MM-DD in UTC, the daily cap's key. */
function currentDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function currentYearMonth(now: Date = new Date()): string {
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${y}-${m}`;
}
