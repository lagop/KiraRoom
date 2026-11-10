/**
 * Connecting the salon's Stripe account: it is created once per salon and
 * mode, prefilled, and the salon is sent to Stripe's own form; the status is
 * read back from Stripe; Stripe failing never leaves a half state or leaks a key.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { ConnectAccountsService } from './connect-accounts.service';

const tenantRow = (over: Record<string, unknown> = {}) => ({
  id: 't1',
  name: 'Kira Room',
  legalName: null,
  email: 'info@kira.test',
  website: null,
  country: 'ES',
  stripeConnectAccountId: null,
  stripeConnectLivemode: null,
  stripeConnectChargesEnabled: false,
  stripeConnectPayoutsEnabled: false,
  stripeConnectDetailsSubmitted: false,
  stripeConnectRequirementsDue: null,
  stripeConnectDisabledReason: null,
  stripeConnectCheckedAt: null,
  ...over,
});

function build(opts: { row?: any; mode?: 'test' | 'live' | 'none'; stripe?: any } = {}) {
  let row = opts.row === undefined ? tenantRow() : opts.row;
  const prisma = {
    tenant: {
      findUnique: jest.fn(async () => row),
      update: jest.fn(async ({ data }: any) => {
        row = { ...row, ...data };
        return row;
      }),
    },
  };
  const stripe = opts.stripe ?? {
    accounts: {
      create: jest.fn(async () => ({
        id: 'acct_new',
        charges_enabled: false,
        payouts_enabled: false,
        details_submitted: false,
        requirements: { currently_due: ['business_type'] },
      })),
      retrieve: jest.fn(async () => ({
        id: 'acct_new',
        charges_enabled: true,
        payouts_enabled: true,
        details_submitted: true,
        requirements: { currently_due: [], disabled_reason: null },
      })),
    },
    accountLinks: { create: jest.fn(async () => ({ url: 'https://connect.stripe.com/setup/e/acct_new/xyz' })) },
  };
  const mode = opts.mode ?? 'test';
  const platform = { mode: () => mode, client: () => (mode === 'none' ? null : stripe) };
  const config = { get: (k: string) => (k === 'APP_BASE_URL' ? 'https://app.kiraroom.net' : undefined) };
  const service = new ConnectAccountsService(prisma as any, platform as any, config as any);
  (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service, prisma, stripe, getRow: () => row };
}

describe('ConnectAccountsService', () => {
  it('a salon with nothing started shows "none"; no keys at all says the platform is not ready', async () => {
    expect(await build().service.status('t1')).toMatchObject({ state: 'none', platformReady: true });
    expect(await build({ mode: 'none' }).service.status('t1')).toMatchObject({ state: 'none', platformReady: false });
  });

  it("starting creates the account once, prefilled, and returns Stripe's form link back to the panel", async () => {
    const { service, stripe, getRow } = build();
    const out = await service.startOnboarding('t1');
    expect(out.url).toBe('https://connect.stripe.com/setup/e/acct_new/xyz');
    const [params, options] = stripe.accounts.create.mock.calls[0];
    expect(params).toMatchObject({ country: 'ES', email: 'info@kira.test', metadata: { kiraroomTenantId: 't1' } });
    expect(options.idempotencyKey).toBe('connect-account-t1-test');
    expect(stripe.accountLinks.create).toHaveBeenCalledWith({
      account: 'acct_new',
      type: 'account_onboarding',
      return_url: 'https://app.kiraroom.net/dashboard/settings/cobros-online?connect=return',
      refresh_url: 'https://app.kiraroom.net/dashboard/settings/cobros-online?connect=refresh',
    });
    expect(getRow()).toMatchObject({ stripeConnectAccountId: 'acct_new', stripeConnectLivemode: false });
  });

  it('coming back to finish reuses the account instead of creating another', async () => {
    const { service, stripe } = build({ row: tenantRow({ stripeConnectAccountId: 'acct_old', stripeConnectLivemode: false }) });
    await service.startOnboarding('t1');
    expect(stripe.accounts.create).not.toHaveBeenCalled();
    expect(stripe.accountLinks.create.mock.calls[0][0].account).toBe('acct_old');
  });

  it('an account of the other Stripe mode is not reused: a new one is created for the mode in force', async () => {
    const { service, stripe, getRow } = build({
      mode: 'live',
      row: tenantRow({ stripeConnectAccountId: 'acct_test', stripeConnectLivemode: false, stripeConnectChargesEnabled: true }),
    });
    await service.startOnboarding('t1');
    expect(stripe.accounts.create).toHaveBeenCalledTimes(1);
    expect(stripe.accounts.create.mock.calls[0][1].idempotencyKey).toBe('connect-account-t1-live');
    expect(getRow()).toMatchObject({
      stripeConnectAccountId: 'acct_new',
      stripeConnectLivemode: true,
      stripeConnectChargesEnabled: false,
    });
  });

  it('refresh reads the account from Stripe and saves what it says', async () => {
    const { service, getRow } = build({ row: tenantRow({ stripeConnectAccountId: 'acct_new', stripeConnectLivemode: false }) });
    const s = await service.refresh('t1');
    expect(s).toMatchObject({ state: 'active', canCharge: true });
    expect(getRow()).toMatchObject({ stripeConnectChargesEnabled: true, stripeConnectDetailsSubmitted: true });
  });

  it('refresh without an account does not call Stripe', async () => {
    const { service, stripe } = build();
    await service.refresh('t1');
    expect(stripe.accounts.retrieve).not.toHaveBeenCalled();
  });

  it('Stripe failing is a clear 503 and never shows a key; Connect not enabled says so plainly', async () => {
    const failing = {
      accounts: {
        create: jest.fn(async () => {
          throw new Error('Invalid API Key provided: sk_test_abcdefghij1234');
        }),
        retrieve: jest.fn(),
      },
      accountLinks: { create: jest.fn() },
    };
    const a = build({ stripe: failing });
    await expect(a.service.startOnboarding('t1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(a.service.startOnboarding('t1')).rejects.not.toThrow(/sk_test_abcdefghij1234/);
    const noConnect = {
      accounts: {
        create: jest.fn(async () => {
          throw new Error('You can only create new accounts if you have signed up for Connect');
        }),
        retrieve: jest.fn(),
      },
      accountLinks: { create: jest.fn() },
    };
    await expect(build({ stripe: noConnect }).service.startOnboarding('t1')).rejects.toThrow(
      /cobros online todavía no están disponibles/,
    );
  });

  it('without keys, starting is refused before any call', async () => {
    const { service } = build({ mode: 'none' });
    await expect(service.startOnboarding('t1')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });
});
