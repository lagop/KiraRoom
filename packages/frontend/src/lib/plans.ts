// Plan / feature gating for the frontend.
//
// This file used to declare its own PLAN_MATRIX, and it had drifted: it
// still listed `virtual_receptionist` as Pro-only after it moved to
// Esencial, and it knew nothing about `multichannel`, `copilot_read` or
// `copilot_write`. The result was an "upgrade to Pro" prompt shown to
// tenants who already had the feature, and no gate at all for the ones it
// had never heard of.
//
// The matrix now lives in @kira/shared and both sides import it, so a
// change lands in one place. What remains here is frontend presentation.

import {
  PLAN_FEATURES,
  PLAN_IDS,
  PLAN_LABELS_ES,
  PLAN_PRICES,
  PARKED_FEATURE_KEYS,
  minPlanFor,
  normalizePlan as normalizePlanShared,
  planIncludes,
  type FeatureKey,
  type PlanId,
} from "@kira/shared";

export type { FeatureKey, PlanId };
export { PARKED_FEATURE_KEYS, PLAN_IDS };

/** Kept for call sites that iterate the matrix directly. */
export const PLAN_MATRIX: Readonly<Record<PlanId, ReadonlyArray<FeatureKey>>> =
  PLAN_FEATURES;

export const PLAN_LABELS = PLAN_LABELS_ES;
export const PLAN_PRICE_EUR = PLAN_PRICES;

export const normalizePlan = normalizePlanShared;

export const isFeatureEnabledForPlan = (
  plan: PlanId,
  key: FeatureKey,
): boolean => planIncludes(plan, key);

/**
 * Plan a tenant must be on to unlock a feature, for upgrade CTAs.
 * `null` means no plan includes it -- it is add-on only.
 */
export const featureMinPlan = (key: FeatureKey): PlanId | null =>
  minPlanFor(key);

/**
 * Legacy shape of the above, kept so existing imports keep compiling.
 * Prefer `featureMinPlan`, which can express "add-on only".
 */
export const FEATURE_MIN_PLAN = new Proxy(
  {} as Record<FeatureKey, PlanId>,
  {
    get: (_t, key: string) => minPlanFor(key as FeatureKey) ?? "empresa",
  },
);
