/**
 * The salon's connected Stripe account: which state the panel shows, the
 * account KiraRoom asks Stripe to create (prefilled, direct charges), and the
 * addresses Stripe sends the salon back to.
 */
import {
  ConnectTenantRow,
  connectAccountParams,
  connectFieldsFromAccount,
  connectReturnUrls,
  connectStatusOf,
} from './stripe-connect';

const row = (over: Partial<ConnectTenantRow> = {}): ConnectTenantRow => ({
  stripeConnectAccountId: 'acct_123',
  stripeConnectLivemode: false,
  stripeConnectChargesEnabled: false,
  stripeConnectPayoutsEnabled: false,
  stripeConnectDetailsSubmitted: false,
  stripeConnectRequirementsDue: [],
  stripeConnectDisabledReason: null,
  stripeConnectCheckedAt: null,
  ...over,
});

describe('connectStatusOf', () => {
  it('no account: nothing started', () => {
    expect(connectStatusOf(row({ stripeConnectAccountId: null }), false)).toMatchObject({
      state: 'none',
      canCharge: false,
      otherMode: false,
    });
  });

  it('an account Stripe still needs details for is pending and cannot charge', () => {
    const s = connectStatusOf(row({ stripeConnectRequirementsDue: ['individual.id_number'] }), false);
    expect(s).toMatchObject({ state: 'pending', canCharge: false, requirementsDue: ['individual.id_number'] });
  });

  it('charges and payouts on with nothing due is active', () => {
    const s = connectStatusOf(
      row({ stripeConnectChargesEnabled: true, stripeConnectPayoutsEnabled: true, stripeConnectDetailsSubmitted: true }),
      false,
    );
    expect(s).toMatchObject({ state: 'active', canCharge: true, payoutsEnabled: true });
  });

  it('able to charge but with something due, or paused, is restricted (never active)', () => {
    const due = connectStatusOf(
      row({
        stripeConnectChargesEnabled: true,
        stripeConnectPayoutsEnabled: true,
        stripeConnectRequirementsDue: ['external_account'],
      }),
      false,
    );
    expect(due.state).toBe('restricted');
    const paused = connectStatusOf(row({ stripeConnectDisabledReason: 'requirements.past_due' }), false);
    expect(paused).toMatchObject({ state: 'restricted', canCharge: false, disabledReason: 'requirements.past_due' });
  });

  it('an account of the other Stripe mode counts as not connected, and says so', () => {
    const s = connectStatusOf(row({ stripeConnectChargesEnabled: true, stripeConnectLivemode: false }), true);
    expect(s).toMatchObject({ state: 'none', canCharge: false, otherMode: true });
  });

  it('an unknown mode counts as the one in force; no keys at all do not hide the account', () => {
    expect(
      connectStatusOf(
        row({ stripeConnectLivemode: null, stripeConnectChargesEnabled: true, stripeConnectPayoutsEnabled: true }),
        true,
      ).state,
    ).toBe('active');
    expect(connectStatusOf(row({ stripeConnectChargesEnabled: true }), null).otherMode).toBe(false);
  });

  it('a requirements value that is not a list is read as nothing due', () => {
    expect(connectStatusOf(row({ stripeConnectRequirementsDue: { x: 1 } }), false).requirementsDue).toEqual([]);
  });
});

describe('connectFieldsFromAccount', () => {
  it('keeps the status Stripe reported, with the mode, and nothing secret', () => {
    const fields = connectFieldsFromAccount(
      {
        id: 'acct_9',
        charges_enabled: true,
        payouts_enabled: false,
        details_submitted: true,
        requirements: { currently_due: ['a', 'b'], disabled_reason: null },
      } as any,
      true,
    );
    expect(fields).toMatchObject({
      stripeConnectAccountId: 'acct_9',
      stripeConnectLivemode: true,
      stripeConnectChargesEnabled: true,
      stripeConnectPayoutsEnabled: false,
      stripeConnectDetailsSubmitted: true,
      stripeConnectRequirementsDue: ['a', 'b'],
      stripeConnectDisabledReason: null,
    });
    expect(fields.stripeConnectCheckedAt).toBeInstanceOf(Date);
  });
});

describe('connectAccountParams', () => {
  const t = {
    tenantId: 't1',
    name: 'Kira Room',
    legalName: 'Kira Room SL',
    email: 'info@kira.test',
    website: 'https://kira.test',
    country: 'es',
  };

  it('is a direct-charge account like Standard: own dashboard, Stripe collects the details, the account pays fees', () => {
    const p = connectAccountParams(t);
    expect(p.controller).toEqual({
      stripe_dashboard: { type: 'full' },
      requirement_collection: 'stripe',
      fees: { payer: 'account' },
      losses: { payments: 'stripe' },
    });
    expect((p as any).type).toBeUndefined();
  });

  it('prefills what KiraRoom knows, and ties the account to the salon', () => {
    const p = connectAccountParams(t);
    expect(p).toMatchObject({
      country: 'ES',
      email: 'info@kira.test',
      business_profile: { name: 'Kira Room SL', mcc: '7230', url: 'https://kira.test/' },
      metadata: { kiraroomTenantId: 't1' },
    });
  });

  it('works with little: no email, no website, no legal name, no country', () => {
    const p = connectAccountParams({ tenantId: 't2', name: 'Salón', legalName: null, email: null, website: null, country: null });
    expect(p.country).toBe('ES');
    expect(p.email).toBeUndefined();
    expect(p.business_profile).toEqual({ name: 'Salón', mcc: '7230' });
  });

  it('leaves out a website Stripe would refuse', () => {
    expect(connectAccountParams({ ...t, website: 'javascript:alert(1)' }).business_profile?.url).toBeUndefined();
    expect(connectAccountParams({ ...t, website: 'not a url' }).business_profile?.url).toBeUndefined();
  });
});

describe('connectReturnUrls', () => {
  it('sends the salon back to the panel page, whatever slash the base has', () => {
    expect(connectReturnUrls('https://app.kiraroom.net/')).toEqual({
      returnUrl: 'https://app.kiraroom.net/dashboard/settings/cobros-online?connect=return',
      refreshUrl: 'https://app.kiraroom.net/dashboard/settings/cobros-online?connect=refresh',
    });
  });
});
