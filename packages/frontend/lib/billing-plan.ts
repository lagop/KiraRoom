/**
 * What each plan card on the billing page offers, from the salon's current
 * subscription. Pure, tested in billing-plan.spec.ts.
 *
 * - "current": its plan, nothing to do.
 * - "subscribe": its plan while in the free trial: it can pay for it now
 *   (the first charge waits for the trial to end, see the backend's
 *   checkoutTrialEnd).
 * - "checkout": another plan, through Stripe Checkout (no subscription yet).
 * - "change": another plan on the subscription it already pays; a checkout
 *   there would start a second subscription, billed on top.
 */
export type PlanAction = "current" | "subscribe" | "checkout" | "change";

export interface BillingSubscription {
  plan?: string | null;
  status?: string | null;
  stripeSubscriptionId?: string | null;
}

export function paysSubscription(sub: BillingSubscription | null | undefined): boolean {
  return !!sub?.stripeSubscriptionId && sub.status !== "cancelled";
}

export function planAction(sub: BillingSubscription | null | undefined, planId: string): PlanAction {
  const current = (sub?.plan || "esencial") === planId;
  if (paysSubscription(sub)) return current ? "current" : "change";
  if (current) return sub?.status === "trialing" ? "subscribe" : "current";
  return "checkout";
}
