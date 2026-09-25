/**
 * Startup configuration validators (SEC-1, SEC-3, OAUTH_STATE_SECRET).
 *
 * All checks are pure functions over `process.env` with NO imports from
 * the project's AppModule or any service. This keeps them trivially
 * unit-testable and side-effect-free.
 *
 * SEC-1 (P2A-staff-copilot GA): JWT secret strength check at startup.
 *   Rejects weak / placeholder JWT secrets BEFORE the app boots. Without
 *   this, a misconfigured deploy could ship with the demo secret from
 *   `.env.example` and allow an attacker to mint valid tokens for any
 *   user (the docs/security-review-2026-07.md finding 4).
 *
 *   Allowed escape hatches (all opt-in via env vars):
 *     - ALLOW_WEAK_JWT_SECRET=1   dev/test only (CI uses this)
 *     - JWT_SECRET_LENGTH_MIN     override the 32-char default
 *
 * SEC-3: Stripe webhook signature configuration check at startup.
 *   When STRIPE_SECRET_KEY is configured but STRIPE_WEBHOOK_SECRET is not,
 *   POST /api/v1/webhooks/stripe was silently accepting every event
 *   WITHOUT verifying the `stripe-signature` header. That meant an
 *   attacker who knew any tenant's `stripeCustomerId` could forge
 *   `customer.subscription.deleted` events and cancel that tenant's
 *   subscription, or forge `invoice.paid` to flip `subscriptionStatus`.
 *
 *   Fix:
 *     - In production: refuse to boot when STRIPE_SECRET_KEY is set but
 *       STRIPE_WEBHOOK_SECRET is missing or empty.
 *     - In dev/test: warn via stderr and let the controller-level runtime
 *       guard return 503 if the endpoint is actually hit unsigned.
 *     - Escape hatch: ALLOW_UNVERIFIED_STRIPE_WEBHOOK=1 for unit tests
 *       that exercise the controller without a real secret.
 *
 * OAUTH_STATE_SECRET: signing key for the OAuth state parameter used by
 *   the accounting integrations (Holded, Sage, A3, NCS). Without a
 *   strong secret, an attacker who can guess or replay a `state` value
 *   could hijack a tenant's accounting OAuth flow.
 *
 *   Previously checked at controller-construction time
 *   (accounting.controller.ts:32-46) which means the check fired AFTER
 *   NestJS had finished bootstrapping the DI graph. Moving the check
 *   here means a misconfigured deploy fails before any work happens.
 *   The controller-level check is kept as defense-in-depth.
 *
 *   Allowed escape hatches:
 *     - ALLOW_WEAK_OAUTH_STATE_SECRET=1   unit tests only
 */

export function assertJwtSecret(): Error | null {
  const allowWeak = process.env.ALLOW_WEAK_JWT_SECRET === '1';
  const minLength = Number(process.env.JWT_SECRET_LENGTH_MIN ?? 32);
  const secret = process.env.JWT_SECRET ?? '';
  if (allowWeak) return null;

  if (!secret) {
    return new Error(
      `JWT_SECRET is required. Set it in your environment or .env file.`,
    );
  }
  if (secret.length < minLength) {
    return new Error(
      `JWT_SECRET must be at least ${minLength} characters (got ${secret.length}).`,
    );
  }
  const placeholders = [
    'change-this',
    'your-super-secret',
    'changeme',
    'development-secret',
    'replace-me',
  ];
  if (placeholders.some((p) => secret.toLowerCase().includes(p))) {
    return new Error(
      `JWT_SECRET appears to be a placeholder value. Replace it with a real random secret.`,
    );
  }
  // Reject pure hex / base64 / numeric strings that look like auto-generated defaults.
  if (/^(.)\1+$/.test(secret)) {
    return new Error(
      `JWT_SECRET appears to be a repeated character. Use a real random value.`,
    );
  }
  return null;
}

export function assertStripeWebhookConfig(): Error | null {
  if (process.env.ALLOW_UNVERIFIED_STRIPE_WEBHOOK === '1') return null;

  const stripeSecret = process.env.STRIPE_SECRET_KEY ?? '';
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET ?? '';
  const isProd = process.env.NODE_ENV === 'production';

  // Stripe not configured at all — nothing to validate.
  if (!stripeSecret) return null;

  if (!webhookSecret) {
    if (isProd) {
      return new Error(
        'STRIPE_WEBHOOK_SECRET is required when STRIPE_SECRET_KEY is set in production. ' +
          'Without it, POST /api/v1/webhooks/stripe would accept unsigned events and ' +
          'let any caller forge subscription cancellations or payment confirmations. ' +
          'Generate one in the Stripe dashboard (Developers → Webhooks → endpoint → ' +
          'Reveal signing secret) and set it in the environment.',
      );
    }
    // Dev / test: allow boot, the runtime guard will refuse live requests.
    // eslint-disable-next-line no-console
    console.warn(
      '[WARN] STRIPE_WEBHOOK_SECRET is not set. The /webhooks/stripe endpoint will ' +
        'return 503 for unsigned requests. Set STRIPE_WEBHOOK_SECRET before going to production.',
    );
    return null;
  }

  // Both set — sanity-check the prefix so a typo doesn't slip through.
  if (!webhookSecret.startsWith('whsec_')) {
    return new Error(
      `STRIPE_WEBHOOK_SECRET must start with "whsec_" (got prefix "${webhookSecret.slice(0, 6)}"). ` +
        'Copy it verbatim from the Stripe dashboard webhook endpoint.',
    );
  }

  return null;
}

export function assertOAuthStateSecret(): Error | null {
  const allowWeak = process.env.ALLOW_WEAK_OAUTH_STATE_SECRET === '1';
  if (allowWeak) return null;

  const OAUTH_MIN_LENGTH = 16;
  const secret = process.env.OAUTH_STATE_SECRET ?? '';
  const isProd = process.env.NODE_ENV === 'production';

  if (!secret) {
    if (isProd) {
      return new Error(
        `OAUTH_STATE_SECRET is required in production. It signs the OAuth state ` +
          'parameter for the accounting integrations (Holded, Sage, A3, NCS); ' +
          'without it an attacker could forge state values and hijack a tenant\'s ' +
          'accounting connection. Generate with: openssl rand -base64 48',
      );
    }
    // Dev / test: warn, the controller-level guard will use its
    // "dev-oauth-secret-do-not-use-in-production" fallback.
    // eslint-disable-next-line no-console
    console.warn(
      '[WARN] OAUTH_STATE_SECRET is not set. The accounting controller will use ' +
        'a dev-only fallback. Do NOT deploy this build to production.',
    );
    return null;
  }

  if (secret.length < OAUTH_MIN_LENGTH) {
    if (isProd) {
      return new Error(
        `OAUTH_STATE_SECRET must be at least ${OAUTH_MIN_LENGTH} characters ` +
          `in production (got ${secret.length}). Generate with: openssl rand -base64 48`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[WARN] OAUTH_STATE_SECRET is shorter than ${OAUTH_MIN_LENGTH} chars ` +
        `(${secret.length}). Dev/test only — production requires ${OAUTH_MIN_LENGTH}+.`,
    );
    return null;
  }

  // Reject the controller's dev fallback if it ever leaked into .env.
  const placeholders = [
    'dev-oauth-secret',
    'change-this',
    'replace-me',
    'do-not-use',
  ];
  if (placeholders.some((p) => secret.toLowerCase().includes(p))) {
    return new Error(
      `OAUTH_STATE_SECRET appears to be a placeholder value. Replace it with a real random secret.`,
    );
  }

  // Reject pure-repeating strings.
  if (/^(.)\1+$/.test(secret)) {
    return new Error(
      `OAUTH_STATE_SECRET appears to be a repeated character. Use a real random value.`,
    );
  }

  return null;
}

export function validateJwtSecretOrExit(exit = process.exit): void {
  const err = assertJwtSecret();
  if (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[FATAL] ${err.message}\n` +
        `       Generate a new one with: openssl rand -base64 48`,
    );
    exit(1);
  }
}

export function validateStripeWebhookConfigOrExit(
  exit = process.exit,
): void {
  const err = assertStripeWebhookConfig();
  if (err) {
    // eslint-disable-next-line no-console
    console.error(`[FATAL] ${err.message}`);
    exit(1);
  }
}

export function validateOAuthStateSecretOrExit(
  exit = process.exit,
): void {
  const err = assertOAuthStateSecret();
  if (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[FATAL] ${err.message}\n` +
        `       Generate a new one with: openssl rand -base64 48`,
    );
    exit(1);
  }
}

/**
 * SEC-7: refresh tokens must be signed with their own key.
 *
 * `auth.service.ts` signs refresh tokens with an explicit
 * `{ secret: process.env.JWT_REFRESH_SECRET }` and verifies them the same
 * way. The variable was never set in production, and `@nestjs/jwt` treats
 * `secret: undefined` as "not overridden": it falls back to the secret the
 * JwtModule was registered with, which is JWT_SECRET.
 *
 * Verified against the installed @nestjs/jwt: with JWT_REFRESH_SECRET
 * unset, a token minted as an ACCESS token verifies successfully as a
 * REFRESH token. The two payloads are identical (`sub` + `role`), so only
 * `expiresIn` distinguishes them, and `expiresIn` is not checked when
 * refreshing.
 *
 * Consequence: a leaked 15-minute access token can be presented to
 * POST /auth/refresh and exchanged for a fresh access + refresh pair,
 * then again indefinitely. The short access-token lifetime -- the reason
 * for having a separate refresh token at all -- buys nothing.
 *
 * Fix: require a distinct JWT_REFRESH_SECRET in production, and refuse to
 * boot without one rather than falling back silently. Dev and test warn
 * instead, and CI's existing ALLOW_WEAK_JWT_SECRET=1 opts out.
 */
export function assertJwtRefreshSecret(): Error | null {
  if (process.env.ALLOW_WEAK_JWT_SECRET === '1') return null;

  const minLength = Number(process.env.JWT_SECRET_LENGTH_MIN ?? 32);
  const secret = process.env.JWT_REFRESH_SECRET ?? '';
  const accessSecret = process.env.JWT_SECRET ?? '';
  const isProd = process.env.NODE_ENV === 'production';

  const explain =
    'Refresh tokens are signed with JWT_REFRESH_SECRET; when it is unset, ' +
    '@nestjs/jwt silently signs and verifies them with JWT_SECRET instead, ' +
    'so any access token can be redeemed at POST /auth/refresh for a new ' +
    'token pair. Generate one with: openssl rand -base64 48';

  if (!secret) {
    if (isProd) {
      return new Error(`JWT_REFRESH_SECRET is required in production. ${explain}`);
    }
    // eslint-disable-next-line no-console
    console.warn(
      '[WARN] JWT_REFRESH_SECRET is not set, so refresh tokens are signed with ' +
        'JWT_SECRET and every access token doubles as a refresh token. ' +
        'Do NOT deploy this build to production.',
    );
    return null;
  }

  if (secret === accessSecret) {
    return new Error(
      'JWT_REFRESH_SECRET must differ from JWT_SECRET. Sharing one key means ' +
        'an access token is also a valid refresh token. ' +
        'Generate a separate one with: openssl rand -base64 48',
    );
  }

  if (secret.length < minLength) {
    if (isProd) {
      return new Error(
        `JWT_REFRESH_SECRET must be at least ${minLength} characters in ` +
          `production (got ${secret.length}). Generate with: openssl rand -base64 48`,
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[WARN] JWT_REFRESH_SECRET is shorter than ${minLength} chars ` +
        `(${secret.length}). Dev/test only.`,
    );
    return null;
  }

  const placeholders = [
    'change-this',
    'your-super-secret',
    'changeme',
    'development-secret',
    'replace-me',
  ];
  if (placeholders.some((p) => secret.toLowerCase().includes(p))) {
    return new Error(
      'JWT_REFRESH_SECRET appears to be a placeholder value. Replace it with a real random secret.',
    );
  }
  if (/^(.)\1+$/.test(secret)) {
    return new Error(
      'JWT_REFRESH_SECRET appears to be a repeated character. Use a real random value.',
    );
  }

  return null;
}

export function validateJwtRefreshSecretOrExit(exit = process.exit): void {
  const err = assertJwtRefreshSecret();
  if (err) {
    // eslint-disable-next-line no-console
    console.error(
      `[FATAL] ${err.message}\n` +
        `       Generate a new one with: openssl rand -base64 48`,
    );
    exit(1);
  }
}
