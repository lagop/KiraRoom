import type Stripe from 'stripe';

/** What a paid checkout or subscription says about the tenant's plan. */
export interface PlanActivation {
  tenantId: string;
  plan?: string;
  locations?: number;
  customerId?: string;
  subscriptionId?: string;
}

const PLANS = new Set(['esencial', 'pro', 'empresa']);

function plan(value: unknown): string | undefined {
  return typeof value === 'string' && PLANS.has(value) ? value : undefined;
}

function locations(value: unknown): number | undefined {
  const n = Number(value);
  return Number.isInteger(n) && n >= 1 ? n : undefined;
}

function id(value: string | { id: string } | null | undefined): string | undefined {
  if (!value) return undefined;
  return typeof value === 'string' ? value : value.id;
}

/** A completed subscription checkout (createCheckoutSession sets the metadata). */
export function activationFromCheckout(session: Stripe.Checkout.Session): PlanActivation | null {
  if (session.mode !== 'subscription') return null;
  if (session.payment_status === 'unpaid') return null;
  const tenantId = session.metadata?.tenantId ?? session.client_reference_id ?? undefined;
  if (!tenantId) return null;
  return {
    tenantId,
    plan: plan(session.metadata?.plan),
    locations: locations(session.metadata?.locationCount),
    customerId: id(session.customer as any),
    subscriptionId: id(session.subscription as any),
  };
}

/**
 * A plan subscription that is paid (active, or in a Stripe-side trial).
 * Add-on subscriptions (metadata.kind === 'addon') and anything without a
 * tenant are not plan activations.
 */
export function activationFromSubscription(subscription: Stripe.Subscription): PlanActivation | null {
  if (subscription.metadata?.kind === 'addon') return null;
  if (subscription.status !== 'active' && subscription.status !== 'trialing') return null;
  const tenantId = subscription.metadata?.tenantId;
  if (!tenantId) return null;
  return {
    tenantId,
    plan: plan(subscription.metadata?.plan),
    // The item's quantity is what Stripe bills; metadata can lag behind it.
    locations: locations(subscription.items?.data?.[0]?.quantity ?? subscription.metadata?.locationCount),
    customerId: id(subscription.customer as any),
    subscriptionId: subscription.id,
  };
}
