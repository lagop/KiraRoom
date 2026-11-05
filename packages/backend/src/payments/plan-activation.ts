import type Stripe from 'stripe';

/** What a paid checkout or subscription says about the tenant's plan. */
export interface PlanActivation {
  tenantId: string;
  plan?: string;
  locations?: number;
  customerId?: string;
  subscriptionId?: string;
  /** Only from a subscription (not a checkout): its Stripe status. */
  status?: 'active' | 'trialing';
  /** A Stripe-side trial still running: when billing starts. */
  trialEnd?: Date;
  /** The paid period, when Stripe says it. */
  periodStart?: Date;
  periodEnd?: Date;
  /**
   * When the subscription ends because it was cancelled at the end of the
   * period; null when it renews. Undefined when unknown (a checkout).
   */
  cancelAt?: Date | null;
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

/** An add-on billed as an item of the plan subscription (see AddOnsService.purchase). */
export function isAddOnItem(item: Stripe.SubscriptionItem | undefined | null): boolean {
  return item?.metadata?.kind === 'addon';
}

/**
 * The item that bills the plan. Add-ons are items of the same subscription
 * now, so `items.data[0]` is no longer necessarily the plan: reading the
 * locations, or changing the plan, off an add-on item would bill the wrong
 * thing.
 */
export function planItemOf(subscription: Stripe.Subscription): Stripe.SubscriptionItem | undefined {
  const items = subscription.items?.data ?? [];
  return items.find((item) => !isAddOnItem(item));
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
    locations: locations(planItemOf(subscription)?.quantity ?? subscription.metadata?.locationCount),
    customerId: id(subscription.customer as any),
    subscriptionId: subscription.id,
    status: subscription.status,
    trialEnd:
      subscription.status === 'trialing' && subscription.trial_end
        ? new Date(subscription.trial_end * 1000)
        : undefined,
    periodStart: unixDate(subscription.current_period_start),
    periodEnd: unixDate(subscription.current_period_end),
    cancelAt: cancelAtOf(subscription),
  };
}

function unixDate(seconds: number | null | undefined): Date | undefined {
  return typeof seconds === 'number' && seconds > 0 ? new Date(seconds * 1000) : undefined;
}

/**
 * When a subscription set to cancel at the end of its period ends (Stripe's
 * cancel_at, else the end of the period); null when it renews.
 */
export function cancelAtOf(
  subscription: Pick<Stripe.Subscription, 'cancel_at_period_end' | 'cancel_at' | 'current_period_end'>,
): Date | null {
  if (!subscription.cancel_at_period_end && !subscription.cancel_at) return null;
  return unixDate(subscription.cancel_at ?? subscription.current_period_end) ?? null;
}

/**
 * The status a salon gets when its plan subscription is live. It keeps the
 * free trial (Pro) while the trial runs, though it has already subscribed:
 * the checkout delays the first charge to the trial's end (checkoutTrialEnd),
 * so Stripe says "trialing" until then; in the trial's last two days Stripe
 * charges at once, and the salon keeps its Pro days all the same. The daily
 * BillingScheduler moves it to active once the trial is over.
 */
export function liveStatusFor(
  tenant: { subscriptionStatus: string | null; trialEnd: Date | null },
  activation: Pick<PlanActivation, 'status' | 'trialEnd'>,
  now: Date,
): 'active' | 'trialing' {
  if (activation.status === 'trialing' && activation.trialEnd && activation.trialEnd.getTime() > now.getTime()) {
    return 'trialing';
  }
  const inTrial =
    tenant.subscriptionStatus === 'trialing' && !!tenant.trialEnd && tenant.trialEnd.getTime() > now.getTime();
  return inTrial ? 'trialing' : 'active';
}

/**
 * Stripe Checkout refuses a trial_end less than 48 hours away; an hour of
 * margin covers the time between building the session and Stripe reading it.
 */
const MIN_TRIAL_LEFT_MS = 49 * 60 * 60 * 1000;

/**
 * When a salon in its free trial subscribes, the first charge waits for the
 * trial to end (Unix seconds for subscription_data.trial_end): subscribing
 * early must not cost it the days it has left. Undefined (charge now) out of
 * trial, or in its last two days.
 */
export function checkoutTrialEnd(
  tenant: { subscriptionStatus: string | null; trialEnd: Date | null },
  now: Date,
): number | undefined {
  if (tenant.subscriptionStatus !== 'trialing' || !tenant.trialEnd) return undefined;
  if (tenant.trialEnd.getTime() - now.getTime() < MIN_TRIAL_LEFT_MS) return undefined;
  return Math.floor(tenant.trialEnd.getTime() / 1000);
}

/**
 * A salon that already pays has a live plan subscription: another checkout
 * would start a second one, billed on top. It changes plan instead.
 */
export function hasLivePlanSubscription(tenant: {
  subscriptionStatus: string | null;
  stripeSubscriptionId: string | null;
}): boolean {
  return !!tenant.stripeSubscriptionId && tenant.subscriptionStatus !== 'cancelled';
}
