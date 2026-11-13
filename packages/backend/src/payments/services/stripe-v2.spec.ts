/** The raw v2 calls: the right request, the parsed answer, Stripe's error without the key. */
import { STRIPE_V2_VERSION, StripeV2Error, stripeV2Post } from './stripe-v2';

// Built at runtime: a fictitious value that only looks like a Stripe key (gitleaks).
const fakeKey = ['sk', 'test', 'abcdefghij1234'].join('_');

const respond = (status: number, body: unknown) =>
  jest.fn(async (_url: string, _init: any) => ({
    ok: status < 400,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }));

describe('stripeV2Post', () => {
  it('POSTs JSON with the key, the v2 version and the idempotency key, and returns the answer', async () => {
    const f = respond(200, { id: 'acct_1', object: 'v2.core.account' });
    const out = await stripeV2Post<{ id: string }>(fakeKey, '/v2/core/accounts', { a: 1 }, { idempotencyKey: 'k1', fetchImpl: f });
    expect(out.id).toBe('acct_1');
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://api.stripe.com/v2/core/accounts');
    expect(init.method).toBe('POST');
    expect(init.headers).toEqual({
      Authorization: `Bearer ${fakeKey}`,
      'Content-Type': 'application/json',
      'Stripe-Version': STRIPE_V2_VERSION,
      'Idempotency-Key': 'k1',
    });
    expect(JSON.parse(init.body)).toEqual({ a: 1 });
  });

  it('no idempotency key, no header', async () => {
    const f = respond(200, { url: 'https://x' });
    await stripeV2Post(fakeKey, '/v2/core/account_links', {}, { fetchImpl: f });
    expect(f.mock.calls[0][1].headers['Idempotency-Key']).toBeUndefined();
  });

  it("an error carries Stripe's code and message, never the key", async () => {
    const f = respond(400, { error: { type: 'invalid_request_error', code: 'mcc_invalid', message: 'The MCC is not valid' } });
    const err: any = await stripeV2Post(fakeKey, '/v2/core/accounts', {}, { fetchImpl: f }).catch((e: any) => e);
    expect(err).toBeInstanceOf(StripeV2Error);
    expect(err.message).toBe('mcc_invalid: The MCC is not valid');
    expect(err.status).toBe(400);
    expect(err.code).toBe('mcc_invalid');
    expect(err.message).not.toContain(fakeKey);
  });

  it('an error without a JSON body still says the status', async () => {
    const err: any = await stripeV2Post(fakeKey, '/v2/core/accounts', {}, { fetchImpl: respond(502, '<html>bad gateway</html>') }).catch(
      (e: any) => e,
    );
    expect(err.message).toBe('HTTP 502');
    expect(err.code).toBeNull();
  });
});
