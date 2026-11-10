/**
 * The salon's own Stripe account for online payments (señal / pago anticipado),
 * connected through KiraRoom's platform with Stripe Connect.
 *
 * Direct charges: the payment is made on the salon's account, so the money
 * and the contract are between the salon and Stripe; KiraRoom holds no funds
 * and no secret key of the salon, only the account id and the status Stripe
 * last reported. The account behaves like a "Standard" one, built with
 * controller properties (Stripe deprecated the account types): the salon has
 * its own Stripe Dashboard, Stripe collects its identity and bank details,
 * the account pays Stripe's fees and answers for negative balances.
 *
 * Pure, so it is tested without Stripe (stripe-connect.spec.ts).
 */
import type Stripe from 'stripe';

/** Where a salon stands with its connection, in the terms the panel shows. */
export type ConnectState =
  | 'none' //       nothing started (or an account of the other Stripe mode)
  | 'pending' //    account created, Stripe still needs its details
  | 'restricted' // it was working, or can charge, but Stripe asks for something more / paused it
  | 'active'; //    can take payments and receive transfers

export interface ConnectTenantRow {
  stripeConnectAccountId: string | null;
  stripeConnectLivemode: boolean | null;
  stripeConnectChargesEnabled: boolean;
  stripeConnectPayoutsEnabled: boolean;
  stripeConnectDetailsSubmitted: boolean;
  stripeConnectRequirementsDue: unknown;
  stripeConnectDisabledReason: string | null;
  stripeConnectCheckedAt: Date | null;
}

export interface ConnectStatus {
  state: ConnectState;
  /** The salon can take online payments now. */
  canCharge: boolean;
  /** Stripe can pay out to its bank account. */
  payoutsEnabled: boolean;
  /** Stripe's list of what it still needs, as it sends it (field paths), for the panel to summarise. */
  requirementsDue: string[];
  /** Why Stripe paused the account, when it did. */
  disabledReason: string | null;
  /** The account exists but belongs to the other Stripe mode than the platform keys in force. */
  otherMode: boolean;
  checkedAt: string | null;
}

/** `livemode` of the platform keys in force: null when there are none. */
export function connectStatusOf(row: ConnectTenantRow, platformLivemode: boolean | null): ConnectStatus {
  const hasAccount = !!row.stripeConnectAccountId;
  // Unknown mode (created before it was recorded) counts as the same one, as for customers.
  const otherMode =
    hasAccount &&
    platformLivemode !== null &&
    row.stripeConnectLivemode !== null &&
    row.stripeConnectLivemode !== platformLivemode;
  const due = Array.isArray(row.stripeConnectRequirementsDue)
    ? (row.stripeConnectRequirementsDue as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];

  if (!hasAccount || otherMode) {
    return {
      state: 'none',
      canCharge: false,
      payoutsEnabled: false,
      requirementsDue: [],
      disabledReason: null,
      otherMode: hasAccount && otherMode,
      checkedAt: null,
    };
  }

  const canCharge = row.stripeConnectChargesEnabled;
  let state: ConnectState;
  if (canCharge && row.stripeConnectPayoutsEnabled && !row.stripeConnectDisabledReason && due.length === 0) {
    state = 'active';
  } else if (canCharge || row.stripeConnectDisabledReason) {
    state = 'restricted';
  } else {
    state = 'pending';
  }
  return {
    state,
    canCharge,
    payoutsEnabled: row.stripeConnectPayoutsEnabled,
    requirementsDue: due,
    disabledReason: row.stripeConnectDisabledReason,
    otherMode: false,
    checkedAt: row.stripeConnectCheckedAt ? row.stripeConnectCheckedAt.toISOString() : null,
  };
}

/** What to save from the account Stripe returned. */
export function connectFieldsFromAccount(account: Stripe.Account, livemode: boolean | null) {
  return {
    stripeConnectAccountId: account.id,
    stripeConnectLivemode: livemode,
    stripeConnectChargesEnabled: account.charges_enabled === true,
    stripeConnectPayoutsEnabled: account.payouts_enabled === true,
    stripeConnectDetailsSubmitted: account.details_submitted === true,
    stripeConnectRequirementsDue: (account.requirements?.currently_due ?? []) as string[],
    stripeConnectDisabledReason: account.requirements?.disabled_reason ?? null,
    stripeConnectCheckedAt: new Date(),
  };
}

export interface ConnectTenantIdentity {
  name: string;
  legalName: string | null;
  email: string | null;
  website: string | null;
  country: string | null;
  tenantId: string;
}

/** A website Stripe will accept (https or http); anything else is left out. */
function usableWebsite(url: string | null): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(url);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.toString() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The account to create, prefilled with what KiraRoom already knows so the
 * salon fills fewer fields in Stripe's own form (identity, bank and tax
 * details are always collected by Stripe).
 */
export function connectAccountParams(t: ConnectTenantIdentity): Stripe.AccountCreateParams {
  const country = (t.country || 'ES').toUpperCase();
  const url = usableWebsite(t.website);
  return {
    controller: {
      // The salon's own Stripe Dashboard, where it sees payments, payouts and disputes.
      stripe_dashboard: { type: 'full' },
      // Stripe collects identity, bank and tax details and keeps them up to date.
      requirement_collection: 'stripe',
      // The salon pays Stripe's fees and answers for its negative balances (direct charges).
      fees: { payer: 'account' },
      losses: { payments: 'stripe' },
    },
    country,
    ...(t.email ? { email: t.email } : {}),
    business_profile: {
      name: t.legalName || t.name,
      // 7230: beauty and barber shops.
      mcc: '7230',
      ...(url ? { url } : {}),
    },
    capabilities: { card_payments: { requested: true }, transfers: { requested: true } },
    metadata: { kiraroomTenantId: t.tenantId },
  };
}

/** Where Stripe's onboarding sends the salon back to (the panel's page). */
export function connectReturnUrls(appBase: string): { returnUrl: string; refreshUrl: string } {
  const base = appBase.replace(/\/+$/, '');
  return {
    returnUrl: `${base}/dashboard/settings/cobros-online?connect=return`,
    refreshUrl: `${base}/dashboard/settings/cobros-online?connect=refresh`,
  };
}
