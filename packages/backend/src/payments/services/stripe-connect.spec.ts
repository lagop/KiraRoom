/**
 * The salon's connected Stripe account: which state the panel shows, the
 * account KiraRoom asks Stripe to create (prefilled, direct charges), and the
 * addresses Stripe sends the salon back to.
 */
import {
  ConnectTenantRow,
  connectAccountLinkParams,
  connectAccountParams,
  connectFieldsForNewAccount,
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

describe('connectAccountParams (Accounts v2)', () => {
  const t = {
    tenantId: 't1',
    name: 'Kira Room',
    legalName: 'Kira Room SL',
    email: 'info@kira.test',
    website: 'https://kira.test',
    country: 'es',
  };

  it('is a direct-charge account like Standard: full dashboard, card payments, Stripe takes fees and losses', () => {
    const p = connectAccountParams(t);
    expect(p.dashboard).toBe('full');
    expect(p.configuration).toEqual({ merchant: { capabilities: { card_payments: { requested: true } }, mcc: '7230' } });
    expect(p.defaults.responsibilities).toEqual({ fees_collector: 'stripe', losses_collector: 'stripe' });
    expect((p as any).controller).toBeUndefined();
    expect((p as any).capabilities).toBeUndefined();
  });

  it('prefills what KiraRoom knows, in Spanish and euros, and ties the account to the salon', () => {
    expect(connectAccountParams(t)).toEqual({
      contact_email: 'info@kira.test',
      display_name: 'Kira Room SL',
      dashboard: 'full',
      identity: { country: 'es', business_details: { registered_name: 'Kira Room SL' } },
      configuration: { merchant: { capabilities: { card_payments: { requested: true } }, mcc: '7230' } },
      defaults: {
        currency: 'eur',
        locales: ['es-ES'],
        responsibilities: { fees_collector: 'stripe', losses_collector: 'stripe' },
        profile: { doing_business_as: 'Kira Room', business_url: 'https://kira.test/' },
      },
      metadata: { kiraroomTenantId: 't1' },
    });
  });

  it('works with little: no email, no website, no legal name, no country', () => {
    const p = connectAccountParams({ tenantId: 't2', name: 'Salón', legalName: null, email: null, website: null, country: null });
    expect(p.identity).toEqual({ country: 'es' });
    expect(p.contact_email).toBeUndefined();
    expect(p.display_name).toBe('Salón');
    expect(p.defaults.profile).toEqual({ doing_business_as: 'Salón' });
  });

  it('another country keeps its own country and lets Stripe pick currency and language', () => {
    const p = connectAccountParams({ ...t, country: 'PT' });
    expect(p.identity.country).toBe('pt');
    expect(p.defaults.currency).toBeUndefined();
    expect(p.defaults.locales).toBeUndefined();
  });

  it('leaves out a website Stripe would refuse', () => {
    expect(connectAccountParams({ ...t, website: 'javascript:alert(1)' }).defaults.profile.business_url).toBeUndefined();
    expect(connectAccountParams({ ...t, website: 'not a url' }).defaults.profile.business_url).toBeUndefined();
  });
});

describe('connectAccountLinkParams', () => {
  it("asks for Stripe's onboarding form, everything at once, back to the panel", () => {
    expect(connectAccountLinkParams('acct_1', { returnUrl: 'https://r', refreshUrl: 'https://f' })).toEqual({
      account: 'acct_1',
      use_case: {
        type: 'account_onboarding',
        account_onboarding: { collection_options: { fields: 'eventually_due' }, return_url: 'https://r', refresh_url: 'https://f' },
      },
    });
  });
});

describe('connectFieldsForNewAccount', () => {
  it('a new account is saved with its mode and nothing enabled yet', () => {
    expect(connectFieldsForNewAccount('acct_1', false)).toMatchObject({
      stripeConnectAccountId: 'acct_1',
      stripeConnectLivemode: false,
      stripeConnectChargesEnabled: false,
      stripeConnectPayoutsEnabled: false,
      stripeConnectDetailsSubmitted: false,
      stripeConnectRequirementsDue: [],
      stripeConnectDisabledReason: null,
    });
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
