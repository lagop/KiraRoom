import { Injectable, Logger, ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../common/prisma/prisma.service';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';

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
 * Soft-launch (sprint 16): when the env var
 * `COPILOT_SOFT_LAUNCH_TENANT_IDS` is set to a CSV of tenantIds, only
 * those tenants can use the copilot — even if their plan includes it.
 * The platform team uses this to do the 10-tenant beta without exposing
 * the copilot to every Pro/Premium tenant in the DB. The list is read
 * on every request (no cache) so rotation is instant.
 *
 * Tests:
 *   - L4 specs in `assistant-tier.service.l4.spec.ts` cover tiering.
 *   - Soft-launch is covered by the new L4 specs (set/unset).
 */

export type CopilotTier = 'free' | 'pro' | 'premium';

const APPROX_PREMIUM_FEE_EUR = 99;
const COST_PROTECTION_MULTIPLIER = 3;

@Injectable()
export class AssistantTierService {
  private readonly logger = new Logger(AssistantTierService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagService,
    private readonly config: ConfigService,
  ) {}

  /**
   * Soft-launch whitelist. Returns the set of tenant IDs allowed to
   * access the copilot during the soft-launch window. Empty set means
   * "no restriction" (GA mode).
   */
  softLaunchWhitelist(): Set<string> {
    const raw = this.config.get<string>('COPILOT_SOFT_LAUNCH_TENANT_IDS') ?? '';
    const list = raw.split(',').map((s) => s.trim()).filter(Boolean);
    return new Set(list);
  }

  /**
   * True when the tenant is allowed by the soft-launch whitelist. If
   * the whitelist is empty (GA mode), every tenant is allowed. If the
   * whitelist is non-empty, only listed tenants are allowed.
   */
  isSoftLaunchAllowed(tenantId: string): boolean {
    const whitelist = this.softLaunchWhitelist();
    if (whitelist.size === 0) return true;
    return whitelist.has(tenantId);
  }

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
      'draft_follow_up_message',
      'send_message',
      'reschedule_appointment',
      'mark_no_show',
      'create_coupon',
      'close_waitlist_slot',
    ];
    return all;
  }

  /**
   * Cost-protection check (RFC §15.7). Returns true if the tenant is
   * over the 3× Premium fee cap for the current month. The caller
   * should auto-pause the LLM and surface a billing alert.
   *
   * We approximate cost as 0.02€ per message + 0.05€ per write action
   * (single-shot, no streaming). The numbers are conservative for the
   * current Claude Haiku 4.5 pricing — adjust in this method if
   * pricing changes materially.
   */
  async isOverCostCap(tenantId: string): Promise<boolean> {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    const [messages, actions] = await Promise.all([
      this.prisma.assistantMessage.count({
        where: {
          conversation: { tenantId },
          createdAt: { gte: start },
          role: { in: ['user', 'assistant'] },
        },
      }),
      this.prisma.actionApproval.count({
        where: { tenantId, createdAt: { gte: start } },
      }),
    ]);
    const approxCostEur = messages * 0.02 + actions * 0.05;
    return approxCostEur > APPROX_PREMIUM_FEE_EUR * COST_PROTECTION_MULTIPLIER;
  }
}
