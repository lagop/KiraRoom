/**
 * Connecting the salon's Stripe account: it is created once per salon and
 * mode, prefilled, and the salon is sent to Stripe's own form; the status is
 * read back from Stripe; Stripe failing never leaves a half state or leaks a key.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { ConnectAccountsService } from './connect-accounts.service';

// Built at runtime: a fictitious value that only looks like a Stripe key (gitleaks).
const fakeKey = ['sk', 'test', 'abcdefghij1234'].join('_');

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
  depositExemptReturning: true,
  minCancelHours: 24,
  ...over,
});

/** Stripe's v2 API as the service calls it: creates the account, then the link. */
const v2Ok = () =>
  jest.fn(async (_key: string, path: string, _body?: any, _opts?: any): Promise<any> =>
    path === '/v2/core/accounts' ? { id: 'acct_new', object: 'v2.core.account' } : { url: 'https://accounts.stripe.com/r/acct_new#alu_test' },
  );

function build(opts: { row?: any; mode?: 'test' | 'live' | 'none'; stripe?: any; v2?: jest.Mock } = {}) {
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
  const platform = {
    mode: () => mode,
    client: () => (mode === 'none' ? null : stripe),
    current: () => ({ secretKey: mode === 'none' ? null : fakeKey }),
  };
  const config = { get: (k: string) => (k === 'APP_BASE_URL' ? 'https://app.kiraroom.net' : undefined) };
  const service = new ConnectAccountsService(prisma as any, platform as any, config as any);
  (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  const v2 = opts.v2 ?? v2Ok();
  (service as any).v2Post = v2;
  return { service, prisma, stripe, v2, getRow: () => row };
}

describe('ConnectAccountsService', () => {
  it('a salon with nothing started shows "none"; no keys at all says the platform is not ready', async () => {
    expect(await build().service.status('t1')).toMatchObject({ state: 'none', platformReady: true });
    expect(await build({ mode: 'none' }).service.status('t1')).toMatchObject({ state: 'none', platformReady: false });
  });

  it("starting creates the account once (Accounts v2), prefilled, and returns Stripe's form link back to the panel", async () => {
    const { service, stripe, v2, getRow } = build();
    const out = await service.startOnboarding('t1');
    expect(out.url).toBe('https://accounts.stripe.com/r/acct_new#alu_test');
    const [key, path, params, options] = v2.mock.calls[0];
    expect(key).toBe(fakeKey);
    expect(path).toBe('/v2/core/accounts');
    expect(params).toMatchObject({
      contact_email: 'info@kira.test',
      dashboard: 'full',
      identity: { country: 'es' },
      metadata: { kiraroomTenantId: 't1' },
    });
    expect(options.idempotencyKey).toBe('connect-account-v2-t1-test');
    expect(v2.mock.calls[1].slice(1, 3)).toEqual([
      '/v2/core/account_links',
      {
        account: 'acct_new',
        use_case: {
          type: 'account_onboarding',
          account_onboarding: {
            collection_options: { fields: 'eventually_due' },
            return_url: 'https://app.kiraroom.net/dashboard/settings/cobros-online?connect=return',
            refresh_url: 'https://app.kiraroom.net/dashboard/settings/cobros-online?connect=refresh',
          },
        },
      },
    ]);
    // Never the v1 creation Stripe refuses for new platforms.
    expect(stripe.accounts.create).not.toHaveBeenCalled();
    expect(getRow()).toMatchObject({
      stripeConnectAccountId: 'acct_new',
      stripeConnectLivemode: false,
      stripeConnectChargesEnabled: false,
    });
  });

  it('coming back to finish reuses the account instead of creating another', async () => {
    const { service, v2 } = build({ row: tenantRow({ stripeConnectAccountId: 'acct_old', stripeConnectLivemode: false }) });
    await service.startOnboarding('t1');
    expect(v2).toHaveBeenCalledTimes(1);
    expect(v2.mock.calls[0][1]).toBe('/v2/core/account_links');
    expect(v2.mock.calls[0][2].account).toBe('acct_old');
  });

  it('an account of the other Stripe mode is not reused: a new one is created for the mode in force', async () => {
    const { service, v2, getRow } = build({
      mode: 'live',
      row: tenantRow({ stripeConnectAccountId: 'acct_test', stripeConnectLivemode: false, stripeConnectChargesEnabled: true }),
    });
    await service.startOnboarding('t1');
    expect(v2.mock.calls.filter((c: any[]) => c[1] === '/v2/core/accounts')).toHaveLength(1);
    expect(v2.mock.calls[0][3].idempotencyKey).toBe('connect-account-v2-t1-live');
    expect(getRow()).toMatchObject({
      stripeConnectAccountId: 'acct_new',
      stripeConnectLivemode: true,
      stripeConnectChargesEnabled: false,
    });
  });

  it('the account is saved even if the link then fails, so pressing again reuses it', async () => {
    const v2 = jest.fn(async (_k: string, path: string): Promise<any> => {
      if (path === '/v2/core/accounts') return { id: 'acct_new' };
      throw new Error('api_error: try again');
    });
    const { service, getRow } = build({ v2 });
    await expect(service.startOnboarding('t1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(getRow()).toMatchObject({ stripeConnectAccountId: 'acct_new' });
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
    const leaking = jest.fn(async () => {
      throw new Error(`Invalid API Key provided: ${fakeKey}`);
    });
    const a = build({ v2: leaking });
    await expect(a.service.startOnboarding('t1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    await expect(a.service.startOnboarding('t1')).rejects.not.toThrow(new RegExp(fakeKey));
    for (const message of [
      'You can only create new accounts if you have signed up for Connect',
      'accounts_v2_access_blocked: Accounts v2 is not available for this platform',
    ]) {
      const noConnect = jest.fn(async () => {
        throw new Error(message);
      });
      await expect(build({ v2: noConnect }).service.startOnboarding('t1')).rejects.toThrow(
        /cobros online todavía no están disponibles/,
      );
    }
    const other = jest.fn(async () => {
      throw new Error('mcc_invalid: The MCC is not valid');
    });
    await expect(build({ v2: other }).service.startOnboarding('t1')).rejects.toThrow(/No se ha podido abrir el alta/);
  });

  it("shows the salon's rules for online payments, and changes only what is sent", async () => {
    const { service, prisma, getRow } = build();
    expect((await service.status('t1')).settings).toEqual({ depositExemptReturning: true, minCancelHours: 24 });
    const out = await service.updateSettings('t1', { depositExemptReturning: false });
    expect(out.settings.depositExemptReturning).toBe(false);
    expect(getRow()).toMatchObject({ depositExemptReturning: false });
    prisma.tenant.update.mockClear();
    await service.updateSettings('t1', {});
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('without keys, starting is refused before any call', async () => {
    const { service, v2 } = build({ mode: 'none' });
    await expect(service.startOnboarding('t1')).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(v2).not.toHaveBeenCalled();
  });
});

describe('ConnectAccountsService.summary (what online booking brought in)', () => {
  const rows = [
    { amount: 1500, metadata: { online: true }, refunds: [] },
    { amount: 6000, metadata: { online: true, dispute: { id: 'dp_1', status: 'needs_response' } }, refunds: [] },
    { amount: 2000, metadata: { online: true, dispute: { id: 'dp_2', status: 'lost' } }, refunds: [{ amount: 500 }] },
    { amount: 3000, metadata: { online: true, dispute: { id: 'dp_3', status: 'won' } }, refunds: [{ amount: 3000 }] },
  ];
  function withPayments(found: any[]) {
    const b = build();
    (b.prisma as any).payment = { findMany: jest.fn(async () => found) };
    return b;
  }

  it('adds up what was taken, what went back and the disputes', async () => {
    const { service, prisma } = withPayments(rows);
    const out = await service.summary('t1', 30);
    expect(out).toEqual({
      days: 30,
      payments: 4,
      collectedCents: 12500,
      refundedCents: 3500,
      keptCents: 9000,
      disputes: { open: 1, won: 1, lost: 1 },
    });
    const where = (prisma as any).payment.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ tenantId: 't1', metadata: { path: ['online'], equals: true } });
  });

  it('nothing yet is zeros, and the span is kept within reason', async () => {
    const { service } = withPayments([]);
    expect(await service.summary('t1', 0)).toMatchObject({ days: 30, payments: 0, collectedCents: 0, keptCents: 0 });
    expect((await service.summary('t1', 9999)).days).toBe(366);
  });
});
