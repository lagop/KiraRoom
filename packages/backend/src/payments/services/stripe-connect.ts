/**
 * The salon's own Stripe account for online payments (señal / pago anticipado),
 * connected through KiraRoom's platform with Stripe Connect.
 *
 * Direct charges: the payment is made on the salon's account, so the money
 * and the contract are between the salon and Stripe; KiraRoom holds no funds
 * and no secret key of the salon, only the account id and the status Stripe
 * last reported. The account behaves like a "Standard" one: the salon has
 * its own Stripe Dashboard, Stripe collects its identity and bank details,
 * the account pays Stripe's fees and Stripe answers for losses. It is created
 * with Accounts v2 (stripe-v2.ts); v1 is used for everything else.
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
 * The account to create (Accounts v2, POST /v2/core/accounts), prefilled with
 * what KiraRoom already knows so the salon fills fewer fields in Stripe's own
 * form (identity, bank and tax details are always collected by Stripe).
 *
 * Same account as before, in v2 terms: the salon's own full Stripe Dashboard,
 * the merchant configuration with card payments (direct charges, the salon is
 * the merchant of record), Stripe's fees paid by the account and Stripe
 * answering for losses (so Stripe also collects the requirements). These
 * responsibilities cannot be changed once set.
 */
export function connectAccountParams(t: ConnectTenantIdentity): ConnectAccountV2Params {
  const country = (t.country || 'ES').toLowerCase();
  const url = usableWebsite(t.website);
  const name = t.legalName || t.name;
  return {
    ...(t.email ? { contact_email: t.email } : {}),
    display_name: name,
    dashboard: 'full',
    identity: {
      country,
      ...(t.legalName ? { business_details: { registered_name: t.legalName } } : {}),
    },
    configuration: {
      // 7230: beauty and barber shops.
      merchant: { capabilities: { card_payments: { requested: true } }, mcc: '7230' },
    },
    defaults: {
      ...(country === 'es' ? { currency: 'eur', locales: ['es-ES'] } : {}),
      responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' },
      profile: { doing_business_as: t.name, ...(url ? { business_url: url } : {}) },
    },
    metadata: { kiraroomTenantId: t.tenantId },
  };
}

export interface ConnectAccountV2Params {
  contact_email?: string;
  display_name: string;
  dashboard: 'full';
  identity: { country: string; business_details?: { registered_name: string } };
  configuration: { merchant: { capabilities: { card_payments: { requested: true } }; mcc: string } };
  defaults: {
    currency?: string;
    locales?: string[];
    responsibilities: { fees_collector: 'stripe'; losses_collector: 'stripe' };
    profile: { doing_business_as: string; business_url?: string };
  };
  metadata: Record<string, string>;
}

/** The link to Stripe's onboarding form for the account (POST /v2/core/account_links). */
export function connectAccountLinkParams(accountId: string, urls: { returnUrl: string; refreshUrl: string }) {
  return {
    account: accountId,
    use_case: {
      type: 'account_onboarding' as const,
      account_onboarding: {
        // Everything Stripe will need, asked once, so the salon is not stopped again later.
        collection_options: { fields: 'eventually_due' as const },
        return_url: urls.returnUrl,
        refresh_url: urls.refreshUrl,
      },
    },
  };
}

/**
 * What to save for an account just created: its id and mode, and nothing it
 * can do yet (Stripe still needs the salon's details). The real state comes
 * with Stripe's account.updated events or the panel's «Comprobar».
 */
export function connectFieldsForNewAccount(accountId: string, livemode: boolean | null) {
  return {
    stripeConnectAccountId: accountId,
    stripeConnectLivemode: livemode,
    stripeConnectChargesEnabled: false,
    stripeConnectPayoutsEnabled: false,
    stripeConnectDetailsSubmitted: false,
    stripeConnectRequirementsDue: [] as string[],
    stripeConnectDisabledReason: null,
    stripeConnectCheckedAt: new Date(),
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
