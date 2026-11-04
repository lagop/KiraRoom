/**
 * The salon's plan as every panel screen reads it, from
 * GET /payments/subscription/context (open to the whole team). Pure, tested
 * in plan-context.spec.ts; the hook is src/hooks/useFeatureAccess.ts.
 *
 * It used to come from the owner-only GET /payments/subscription/current:
 * an admin or a professional got a 403, the panel fell back to the token's
 * "esencial / cancelled", locked features the salon pays for (gift cards,
 * analytics, multi-location) and never showed the read-only notice (B2).
 */
import { isFeatureEnabledForPlan, normalizePlan, type FeatureKey, type PlanId } from "../src/lib/plans";
import type { SubscriptionContext } from "./api";

export interface PlanContextView {
  plan: PlanId;
  /** What the salon uses now: Pro during the trial, else its plan. */
  effectivePlan: PlanId;
  inTrial: boolean;
  trialEnd: string | null;
  subscriptionStatus: string;
  /** A paid subscription exists (it may have been taken during the trial). */
  subscribed: boolean;
  cancelledAt: string | null;
  readOnlyUntil: string | null;
  /** Features the salon's active add-ons unlock on top of its plan. */
  addOnFeatures: string[];
}

export function planContextFromServer(sub: SubscriptionContext): PlanContextView {
  const plan = normalizePlan(sub.plan);
  const inTrial = !!sub.inTrial;
  return {
    plan,
    effectivePlan: sub.effectivePlan ? normalizePlan(sub.effectivePlan) : inTrial ? "pro" : plan,
    inTrial,
    trialEnd: sub.trialEnd ?? null,
    subscriptionStatus: sub.status ?? "cancelled",
    subscribed: !!sub.subscribed,
    cancelledAt: sub.cancelledAt ?? null,
    readOnlyUntil: sub.readOnlyUntil ?? null,
    addOnFeatures: Array.isArray(sub.addOnFeatures) ? sub.addOnFeatures : [],
  };
}

/** Cancelled (trial ended, or the plan) or suspended for an unpaid invoice. */
export function isReadOnlyStatus(status: string | null | undefined): boolean {
  return status === "cancelled" || status === "suspended";
}

/**
 * Whether a feature is on: the plan in force includes it, or an active
 * add-on unlocks it (the server's rule, FeatureFlagService). A cancelled
 * salon has nothing on.
 */
export function featureEnabled(
  ctx: Pick<PlanContextView, "subscriptionStatus" | "effectivePlan" | "addOnFeatures">,
  key: FeatureKey,
): boolean {
  if (ctx.subscriptionStatus === "cancelled") return false;
  if (ctx.addOnFeatures.includes(key)) return true;
  if (key === "web_domain") return false;
  return isFeatureEnabledForPlan(ctx.effectivePlan, key);
}

/**
 * The headline of the "not in your plan" card. During the trial (Pro) a
 * feature it lacks is an Empresa one: "Disponible durante tu prueba Pro"
 * said the opposite of the truth (B13).
 */
export function upgradeHeadline(requiredPlanLabel: string, inTrial: boolean, requiredPlan: PlanId): string {
  if (inTrial && requiredPlan === "pro") return "Disponible durante tu prueba Pro";
  return `Disponible en el plan ${requiredPlanLabel}`;
}
