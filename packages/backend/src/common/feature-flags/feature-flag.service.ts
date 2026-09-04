
import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  FeatureKey,
  PlanId,
  SubscriptionsService,
} from '../../payments/services/subscriptions.service';
import { AiFairUseAction } from '@prisma/client';

/**
 * Gating context returned by `getContext()`. v2 expands the legacy
 * plan-only decision to a `plan ∪ addons` union plus the per-tenant
 * AI fair-use fields needed for the counter service.
 *
 * P2A-receptionist-v2 Phase 7: the legacy `Tenant.addons` JSON column
 * is no longer read for entitlement checks. The canonical source is
 * `tenant_add_ons` (joined with `add_ons` to expand `unlocks`). The
 * JSON column is kept on the table only so the migration that
 * surfaced legacy data remains idempotent.
 */
export interface FeatureFlagContext {
  tenantId: string;
  plan: PlanId;
  inTrial: boolean;
  subscriptionStatus: string;

  /** Legacy freeform JSON. Kept as-is during the migration window
   *  (web_domain etc. live here for older tenants until Phase 7
   *  back-fills the TenantAddOn table). */
  addons: Record<string, any>;

  // ---- v2 fields ----
  /** Resolved `featureKeys` from PLAN_MATRIX for the effective plan. */
  planFeatures: ReadonlyArray<FeatureKey>;
  /** `FeatureKey`s unlocked by active TenantAddOn rows (the add-on
   *  catalogue joined with `tenantAddOns.status='active'`). */
  addonsUnlocked: FeatureKey[];

  /** AI fair-use state for fairuse-aware code paths (orchestrator,
   *  scheduler, observability). */
  aiConversationsUsed: number;
  aiFairUseAction: AiFairUseAction;
  aiConversationsResetAt: Date | null;

  locationsCount: number;
}

/**
 * Single source of truth for plan <-> feature gating (v2).
 *
 * Entitlement model: a feature is active when
 *   (plan enables it) OR (an active TenantAddOn row unlocks it).
 *
 * Lighter than v1: one DB roundtrip per `getContext` call (one
 * `tenant.findUnique` + one `tenantAddOn.findMany`). The old
 * `Tenant.addons` JSON column is still read (legacy web_domain path)
 * but only as a fallback for tenants whose add-on hasn't been
 * migrated to TenantAddOn yet.
 */
@Injectable()
export class FeatureFlagService {
  private readonly logger = new Logger(FeatureFlagService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
  ) {}


  /**
   * Load the tenant's gating context. Single DB roundtrip + a small
   * in-memory aggregation. The result is consumed by FeatureGuard
   * for every authenticated request, so keep the select minimal.
   */
  async getContext(tenantId: string): Promise<FeatureFlagContext | null> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        plan: true,
        subscriptionStatus: true,
        trialEnd: true,
        addons: true,
        aiConversationsUsed: true,
        aiFairUseAction: true,
        aiConversationsResetAt: true,
        locations: { select: { id: true } },
        tenantAddOns: {
          where: { status: 'active' },
          select: {
            addOn: { select: { unlocks: true } },
          },
        },
      },
    });
    if (!tenant) return null;

    const inTrial =
      tenant.subscriptionStatus === 'trialing' &&
      !!tenant.trialEnd &&
      tenant.trialEnd.getTime() > Date.now();

    const effectivePlan = this.subscriptions.effectivePlan(tenant.plan, inTrial);
    const planFeatures = this.subscriptions.plans[effectivePlan]?.featureKeys ?? [];

    // Flatten the active TenantAddOn[*].addOn.unlocks JSON arrays.
    const addonsUnlocked: FeatureKey[] = [];
    for (const row of tenant.tenantAddOns ?? []) {
      const unlocks = row.addOn?.unlocks;
      if (Array.isArray(unlocks)) {
        for (const k of unlocks) {
          if (typeof k === 'string') addonsUnlocked.push(k as FeatureKey);
        }
      }
    }

    return {
      tenantId: tenant.id,
      plan: effectivePlan,
      inTrial,
      subscriptionStatus: tenant.subscriptionStatus,
      addons: (tenant.addons as Record<string, any>) ?? {},
      planFeatures,
      addonsUnlocked,
      aiConversationsUsed: tenant.aiConversationsUsed ?? 0,
      aiFairUseAction: (tenant.aiFairUseAction ?? 'degrade') as AiFairUseAction,
      aiConversationsResetAt: tenant.aiConversationsResetAt ?? null,
      locationsCount: tenant.locations?.length ?? 1,
    };
  }


  /**
   * Plan ∪ addons entitlement check.
   *
   * `cancelled` + `suspended` deny every gated feature. `past_due`
   * keeps the tenant productive during the 7-day Stripe grace window.
   *
   * `web_domain` has its own union path because it lives outside the
   * PLAN_MATRIX (legacy add-on).
   */
  async isFeatureUnlocked(
    tenantId: string,
    key: FeatureKey,
  ): Promise<boolean> {
    return (await this.evaluate(tenantId, key)).unlocked;
  }

  /** Legacy alias for callers that haven't migrated to `isFeatureUnlocked`. */
  async isEnabled(tenantId: string, key: FeatureKey): Promise<boolean> {
    return this.isFeatureUnlocked(tenantId, key);
  }

  /**
   * Returns both the unlocked boolean AND the live context so callers
   * that want to also peek at planFeatures/addonsUnlocked (e.g. the
   * orchestrator to decide if advanced AI is available) save an
   * extra `getContext()` round-trip.
   */
  async evaluate(
    tenantId: string,
    key: FeatureKey,
  ): Promise<{ unlocked: boolean; ctx: FeatureFlagContext | null }> {
    const ctx = await this.getContext(tenantId);
    if (!ctx) return { unlocked: false, ctx: null };

    if (
      ctx.subscriptionStatus === 'cancelled' ||
      ctx.subscriptionStatus === 'suspended'
    ) {
      return { unlocked: false, ctx };
    }

    // `web_domain` lives outside the plan matrix. After Phase 7 backfill
    // the canonical source is `tenant_add_ons`; the legacy
    // `Tenant.addons` JSON column is now a no-op read (we leave the
    // field on the type for migrations but no longer query it here).
    if (key === 'web_domain') {
      return {
        unlocked: ctx.addonsUnlocked.includes('web_domain' as FeatureKey),
        ctx,
      };
    }

    const inPlan = ctx.planFeatures.includes(key);
    const inAddon = ctx.addonsUnlocked.includes(key);
    return { unlocked: inPlan || inAddon, ctx };
  }


  /**
   * Throws if the feature is not available in the tenant's entitlement.
   * Preserve the v1 message format so existing 4xx responses don't break.
   */
  async assertEnabled(tenantId: string, key: FeatureKey): Promise<FeatureFlagContext> {
    const result = await this.evaluate(tenantId, key);
    if (!result.unlocked || !result.ctx) {
      throw new Error(`Feature '${key}' no disponible en tu plan actual.`);
    }
    return result.ctx;
  }

  /**
   * Helper for the orchestrator / UI: returns whether multi-location
   * features are *actually usable* (plan includes the key AND tenant
   * has >= 2 locations). The plan key is a precondition; the location
   * count is a runtime check.
   */
  async isMultiLocationActive(tenantId: string): Promise<boolean> {
    const { unlocked, ctx } = await this.evaluate(tenantId, 'multi_location');
    return !!(unlocked && ctx && ctx.locationsCount >= 2);
  }
}
