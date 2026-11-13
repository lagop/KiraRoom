/**
 * The few calls KiraRoom makes to Stripe's v2 API (Accounts v2), sent
 * directly: the stripe-node version in use (14) predates v2, and upgrading it
 * changes subscriptions, Checkout and webhooks, which work today. Everything
 * else (reading the account, Checkout, refunds, disputes) stays on v1, which
 * accepts v2 accounts.
 *
 * Stripe stopped letting new platforms create connected accounts with
 * POST /v1/accounts ("Accounts v1 support" policy), hence these two calls.
 */

/** The API version the v2 calls are made with (the one Stripe documents them with). */
export const STRIPE_V2_VERSION = '2026-10-28.endive';

const STRIPE_API = 'https://api.stripe.com';

export class StripeV2Error extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = 'StripeV2Error';
  }
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{
  ok: boolean;
  status: number;
  text(): Promise<string>;
}>;

/**
 * POSTs a JSON body to a v2 endpoint with the platform's secret key and
 * returns the parsed response. Errors carry Stripe's code and message (never
 * the key: it only travels in the header).
 */
export async function stripeV2Post<T>(
  secretKey: string,
  path: string,
  body: unknown,
  opts: { idempotencyKey?: string; fetchImpl?: FetchLike } = {},
): Promise<T> {
  const doFetch: FetchLike = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${secretKey}`,
    'Content-Type': 'application/json',
    'Stripe-Version': STRIPE_V2_VERSION,
  };
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const res = await doFetch(`${STRIPE_API}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  if (!res.ok) {
    const err = json?.error ?? {};
    const code = typeof err.code === 'string' ? err.code : typeof err.type === 'string' ? err.type : null;
    const message = typeof err.message === 'string' ? err.message : `HTTP ${res.status}`;
    throw new StripeV2Error(code ? `${code}: ${message}` : message, res.status, code);
  }
  return json as T;
}
