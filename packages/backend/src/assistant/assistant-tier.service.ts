import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';
import { estimateCostUsd, type TokenCounts } from '../virtual-receptionist/providers/anthropic-models';

/**
 * P2A-staff-copilot: tier-gating + cost-protection + soft-launch flag.
 *
 * The copilot has two feature flags (mirroring RFC §13):
 *   - copilot_read  (Pro+):   read-only tools + briefing card.
 *   - copilot_write (Premium+): all 6 write tools.
 *
 * The FeatureGuard covers the controller-level gate (so an Esencial
 * tenant can never hit the LLM at all). This service is the
 * *fine-grained* gate used by AssistantService.sendMessage to:
 *   - Hide write tools from Pro tenants' prompts.
 *   - Track per-month message + action counters.
 *   - Apply the RFC §15.7 cost-protection auto-pause at 3× the Premium fee.
 *
 * Tests:
 *   - L4 specs in `assistant-tier.service.l4.spec.ts` cover tiering.
 *   - Soft-launch is covered by the new L4 specs (set/unset).
 */

export type CopilotTier = 'free' | 'pro' | 'premium';

/** Questions a salon may ask the Copilot per UTC day (D4: fewer in the trial). */
export const COPILOT_DAILY_QUESTIONS = 300;
export const COPILOT_TRIAL_DAILY_QUESTIONS = 30;
/**
 * What the Copilot may cost the platform per salon and month, in US dollars
 * of model calls (the providers bill in dollars). About 50,000 questions on
 * Claude Haiku 5.5: a runaway guard, not a limit anyone reaches by using it.
 * COPILOT_MONTHLY_COST_CAP_USD overrides it.
 */
export const COPILOT_MONTHLY_COST_CAP_USD = 25;

/** YYYY-MM-DD in UTC: the day the copilot counters belong to. */
export function copilotUsageDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export type CopilotLimit =
  | { ok: true }
  | { ok: false; reason: 'daily' | 'monthly'; message: string };

@Injectable()
export class AssistantTierService {
  private readonly logger = new Logger(AssistantTierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Return the tenant's effective copilot tier based on the FeatureFlag
   * context. Falls back to `free` when the tenant isn't found.
   */
  async resolveTier(tenantId: string): Promise<CopilotTier> {
    const ctx = await this.flags.getContext(tenantId);
    if (!ctx) return 'free';
    if (ctx.planFeatures.includes('copilot_write' as any)) return 'premium';
    if (ctx.planFeatures.includes('copilot_read' as any)) return 'pro';
    return 'free';
  }

  /**
   * Throws ForbiddenException with a tier-aware payload if the tenant
   * doesn't have `copilot_read`. Used at the top of sendMessage to
   * short-circuit before any LLM cost is incurred.
   */
  async assertReadAccess(tenantId: string): Promise<{ tier: CopilotTier }> {
    const tier = await this.resolveTier(tenantId);
    if (tier === 'free') {
      throw new ForbiddenException({
        code: 'COPILOT_NOT_IN_PLAN',
        message: 'El copiloto está disponible en el plan Pro o superior.',
        upgradeUrl: '/dashboard/billing?source=copilot',
      });
    }
    return { tier };
  }

  /**
   * Returns the subset of read tools the tenant can use. Pro gets 5
   * tools (per RFC §13); Premium keeps the full set.
   */
  async allowedReadTools(tenantId: string): Promise<string[]> {
    const tier = await this.resolveTier(tenantId);
    const all = [
      'get_my_agenda',
      'get_salon_agenda',
      'get_client_360',
      'find_filling_opportunities',
      'get_low_stock',
      'get_no_show_history',
      'get_top_clients',
      'get_wait_list',
      // M8: a draft is text for her to copy; nothing is sent, no approval.
      'draft_follow_up_message',
    ];
    if (tier === 'premium' || tier === 'pro') return all;
    return [];
  }

  /**
   * Returns the subset of write tools the tenant can use. Only Premium
   * gets write tools. Manager/owner-of-free still cannot write.
   */
  async allowedWriteTools(tenantId: string): Promise<string[]> {
    const tier = await this.resolveTier(tenantId);
    if (tier !== 'premium') return [];
    const all = [
      'send_message',
      'reschedule_appointment',
      'mark_no_show',
      'create_coupon',
      'close_waitlist_slot',
    ];
    return all;
  }

  // ------------------------------------------------------------------
  //  The Copilot's own counter (copilot_usage_days): questions per day and
  //  real model cost per month. Copilot audit M2/M3, decisions D3/D4.
  // ------------------------------------------------------------------

  /** Questions per day for this salon: fewer while it is in its free trial (D4). */
  async dailyQuestionCap(tenantId: string): Promise<number> {
    const t = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { subscriptionStatus: true, trialEnd: true },
    });
    const inTrial = t?.subscriptionStatus === 'trialing' && !!t.trialEnd && t.trialEnd.getTime() > Date.now();
    return inTrial ? COPILOT_TRIAL_DAILY_QUESTIONS : COPILOT_DAILY_QUESTIONS;
  }

  monthlyCostCapUsd(): number {
    const raw = Number(this.config.get<string>('COPILOT_MONTHLY_COST_CAP_USD'));
    return Number.isFinite(raw) && raw > 0 ? raw : COPILOT_MONTHLY_COST_CAP_USD;
  }

  /** What the Copilot has cost this salon this month (UTC), in US dollars. */
  async costThisMonthUsd(tenantId: string, now: Date = new Date()): Promise<number> {
    const agg = await this.prisma.copilotUsageDay.aggregate({
      where: { tenantId, day: { startsWith: copilotUsageDay(now).slice(0, 8) } },
      _sum: { costMicroUsd: true },
    });
    return Number(agg._sum.costMicroUsd ?? 0n) / 1_000_000;
  }

  /** Questions asked today (UTC). */
  async questionsToday(tenantId: string, now: Date = new Date()): Promise<number> {
    const row = await this.prisma.copilotUsageDay.findUnique({
      where: { tenantId_day: { tenantId, day: copilotUsageDay(now) } },
      select: { messages: true },
    });
    return row?.messages ?? 0;
  }

  /**
   * Counts one question and says whether it may go to the model: within
   * the day's questions and the month's cost. The count is taken first, in
   * one atomic upsert, so two questions at once cannot both slip under the
   * cap; a refused question is given back.
   */
  async claimQuestion(tenantId: string, now: Date = new Date()): Promise<CopilotLimit> {
    if (await this.isOverCostCap(tenantId, now)) {
      return {
        ok: false,
        reason: 'monthly',
        message:
          'El copiloto ha llegado al límite de uso de este mes. Vuelve a estar disponible el día 1. Si lo necesitas antes, escríbenos a soporte.',
      };
    }
    const day = copilotUsageDay(now);
    const [row, cap] = await Promise.all([
      this.prisma.copilotUsageDay.upsert({
        where: { tenantId_day: { tenantId, day } },
        create: { tenantId, day, messages: 1 },
        update: { messages: { increment: 1 } },
        select: { messages: true },
      }),
      this.dailyQuestionCap(tenantId),
    ]);
    if (row.messages > cap) {
      await this.releaseQuestion(tenantId, now);
      return {
        ok: false,
        reason: 'daily',
        message: `Hoy el salón ya ha hecho las ${cap} preguntas diarias del copiloto. Vuelve a estar disponible mañana.`,
      };
    }
    return { ok: true };
  }

  /** Gives a counted question back (refused, or the model failed before answering). */
  async releaseQuestion(tenantId: string, now: Date = new Date()): Promise<void> {
    await this.prisma.copilotUsageDay
      .updateMany({
        where: { tenantId, day: copilotUsageDay(now), messages: { gt: 0 } },
        data: { messages: { decrement: 1 } },
      })
      .catch((err: Error) => this.logger.warn(`Copilot question not released: ${err.message}`));
  }

  /**
   * Adds what a model call cost, from its tokens and the model's price.
   * A model without a price in the table (anthropic-models.ts) adds
   * nothing and is logged: the cost cap then cannot see it.
   */
  async recordCost(tenantId: string, model: string | null | undefined, usage: TokenCounts | null | undefined, now: Date = new Date()): Promise<void> {
    if (!usage) return;
    const usd = estimateCostUsd(model, usage);
    if (usd === null) {
      this.logger.warn(`Copilot cost not counted: no price for model ${model ?? '(none)'}`);
      return;
    }
    const micro = BigInt(Math.max(0, Math.round(usd * 1_000_000)));
    if (micro === 0n) return;
    const day = copilotUsageDay(now);
    await this.prisma.copilotUsageDay
      .upsert({
        where: { tenantId_day: { tenantId, day } },
        create: { tenantId, day, costMicroUsd: micro },
        update: { costMicroUsd: { increment: micro } },
      })
      .catch((err: Error) => this.logger.warn(`Copilot cost not recorded: ${err.message}`));
  }

  /**
   * Cost protection: true once the Copilot's real model cost this month
   * reaches the cap. It used to estimate 0,02 € a message against 3 × 99 €
   * (about 7,400 questions whatever the model): a pricier model in the
   * console did not move it.
   */
  async isOverCostCap(tenantId: string, now: Date = new Date()): Promise<boolean> {
    return (await this.costThisMonthUsd(tenantId, now)) >= this.monthlyCostCapUsd();
  }
}
