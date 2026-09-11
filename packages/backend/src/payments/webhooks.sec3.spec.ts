import { WebhooksController } from './webhooks.controller';

/**
 * SEC-3 (P2A-staff-copilot GA): Stripe webhook signature enforcement
 * at runtime. See docs/security-review-2026-07.md finding 10.
 *
 * Background:
 *   The previous implementation silently processed any event when
 *   STRIPE_WEBHOOK_SECRET was unset, regardless of NODE_ENV. That meant
 *   a misconfigured prod deploy would let any caller forge
 *   `customer.subscription.deleted` or `invoice.paid` events.
 *
 * Contract under test:
 *   - In production, missing secret -> throws 503 (Stripe retries).
 *   - In production, missing signature header -> throws 503.
 *   - In dev/test, missing secret -> warns and processes (so local
 *     `stripe listen --forward-to` works without ceremony).
 *   - ALLOW_UNVERIFIED_STRIPE_WEBHOOK=1 bypasses the production check
 *     (escape hatch for unit tests).
 */
describe('WebhooksController SEC-3 (signature enforcement)', () => {
  const STRIPE_ENV_KEYS = [
    'NODE_ENV',
    'ALLOW_UNVERIFIED_STRIPE_WEBHOOK',
  ];

  function withCleanEnv<T>(fn: () => T): T {
    const saved: Record<string, string | undefined> = {};
    for (const k of STRIPE_ENV_KEYS) saved[k] = process.env[k];
    for (const k of STRIPE_ENV_KEYS) delete process.env[k];
    try {
      return fn();
    } finally {
      for (const k of STRIPE_ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  }

  function buildController(opts: {
    webhookSecret?: string;
    stripe?: any;
  }) {
    const c = Object.create(WebhooksController.prototype) as any;
    c.logger = {
      log: () => {},
      warn: jest.fn(),
      error: jest.fn(),
    };
    c.configService = { get: () => opts.webhookSecret ?? '' } as any;
    // The constructor normally sets `webhookSecret`; we bypass the
    // constructor with Object.create so we set it explicitly here.
    c.webhookSecret = opts.webhookSecret ?? '';
    c.stripe = opts.stripe ?? null;
    c.paymentsService = {} as any;
    c.prisma = {} as any;
    c.email = {} as any;
    c.addonsService = {} as any;
    c.messageBundles = {} as any;
    // Spy on processStripeEvent so we can assert it was/wasn't called.
    c.processStripeEvent = jest.fn().mockResolvedValue({ received: true });
    return c;
  }

  const rawReq = () => ({ rawBody: Buffer.from('{}') }) as any;

  it('throws 503 in production when webhook secret is missing', async () => {
    await withCleanEnv(async () => {
      process.env.NODE_ENV = 'production';
      const c = buildController({ webhookSecret: '', stripe: null });
      await expect(
        c.handleStripeWebhook('sig_abc', { type: 'ping' }, rawReq()),
      ).rejects.toMatchObject({ status: 503 });
    });
  });

  it('throws 503 in production when webhook secret is missing but stripe is configured', async () => {
    await withCleanEnv(async () => {
      process.env.NODE_ENV = 'production';
      const c = buildController({
        webhookSecret: '',
        stripe: { webhooks: { constructEvent: jest.fn() } },
      });
      await expect(
        c.handleStripeWebhook('sig_abc', { type: 'ping' }, rawReq()),
      ).rejects.toMatchObject({ status: 503 });
    });
  });

  it('throws 503 in production when stripe-signature header is missing', async () => {
    await withCleanEnv(async () => {
      process.env.NODE_ENV = 'production';
      const c = buildController({
        webhookSecret: 'whsec_test',
        stripe: { webhooks: { constructEvent: jest.fn() } },
      });
      await expect(
        c.handleStripeWebhook(undefined, { type: 'ping' }, rawReq()),
      ).rejects.toMatchObject({ status: 503 });
    });
  });

  it('processes (with warning) in development when webhook secret is missing', async () => {
    await withCleanEnv(async () => {
      process.env.NODE_ENV = 'development';
      const c = buildController({ webhookSecret: '', stripe: null });
      await c.handleStripeWebhook('sig_abc', { type: 'ping' }, rawReq());
      expect(c.processStripeEvent).toHaveBeenCalled();
      expect(c.logger.warn).toHaveBeenCalled();
    });
  });

  it('processes (with warning) in test when stripe-signature is missing', async () => {
    await withCleanEnv(async () => {
      process.env.NODE_ENV = 'test';
      const c = buildController({
        webhookSecret: 'whsec_test',
        stripe: { webhooks: { constructEvent: jest.fn() } },
      });
      await c.handleStripeWebhook(undefined, { type: 'ping' }, rawReq());
      expect(c.processStripeEvent).toHaveBeenCalled();
      expect(c.logger.warn).toHaveBeenCalled();
    });
  });

  it('ALLOW_UNVERIFIED_STRIPE_WEBHOOK=1 bypasses the production guard', async () => {
    await withCleanEnv(async () => {
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_UNVERIFIED_STRIPE_WEBHOOK = '1';
      const c = buildController({ webhookSecret: '', stripe: null });
      await c.handleStripeWebhook(undefined, { type: 'ping' }, rawReq());
      expect(c.processStripeEvent).toHaveBeenCalled();
    });
  });

  it('verifies signature with Stripe SDK when secret + signature are present', async () => {
    await withCleanEnv(async () => {
      process.env.NODE_ENV = 'production';
      const constructEvent = jest.fn().mockReturnValue({ type: 'ping' });
      const c = buildController({
        webhookSecret: 'whsec_test',
        stripe: { webhooks: { constructEvent } },
      });
      const req = { rawBody: Buffer.from('{"id":"evt_1"}') } as any;
      await c.handleStripeWebhook('t=1,v1=abc', { type: 'ping' }, req);
      expect(constructEvent).toHaveBeenCalledWith(
        '{"id":"evt_1"}',
        't=1,v1=abc',
        'whsec_test',
      );
      expect(c.processStripeEvent).toHaveBeenCalled();
    });
  });

  it('returns signature_verification_failed when SDK throws (keeps Stripe retrying)', async () => {
    await withCleanEnv(async () => {
      process.env.NODE_ENV = 'production';
      const constructEvent = jest.fn().mockImplementation(() => {
        throw new Error('No signatures found matching the expected signature');
      });
      const c = buildController({
        webhookSecret: 'whsec_test',
        stripe: { webhooks: { constructEvent } },
      });
      const req = { rawBody: Buffer.from('{}') } as any;
      const result = await c.handleStripeWebhook('bad-sig', { type: 'ping' }, req);
      expect(result).toEqual(
        expect.objectContaining({ status: 'signature_verification_failed' }),
      );
      expect(c.processStripeEvent).not.toHaveBeenCalled();
    });
  });
});
