import {
  validateJwtSecretOrExit,
  assertJwtSecret,
  assertStripeWebhookConfig,
  validateStripeWebhookConfigOrExit,
} from './startup-checks';

/**
 * SEC-1 (P2A-staff-copilot GA): JWT secret strength check.
 *
 * Asserts that the startup validator rejects weak / placeholder /
 * missing secrets and accepts strong ones. The `validateJwtSecretOrExit`
 * side effect is tested via the soft `assertJwtSecret()`
 * (the exit path is covered manually).
 *
 * Every test resets the env vars it touches so it doesn't leak state
 * between cases.
 */

const ENV_KEYS = [
  'JWT_SECRET',
  'ALLOW_WEAK_JWT_SECRET',
  'JWT_SECRET_LENGTH_MIN',
];

function withCleanEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  try {
    return fn();
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

function strongSecret(): string {
  // 64-char random-ish string; matches the `openssl rand -base64 48`
  // output recommended in the validator's error message.
  return 'Kf9zQpV3nRtX2wLhB7mY1sJ4dGcEaU6oPiW0vNyT8CxH5bM3rD2lA9fS7gK';
}

describe('SEC-1: validateJwtSecretOrExit (L-4)', () => {
  it('rejects missing JWT_SECRET', () => {
    withCleanEnv(() => {
      const err = assertJwtSecret();
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/JWT_SECRET is required/);
    });
  });

  it('rejects short JWT_SECRET (< 32 chars)', () => {
    withCleanEnv(() => {
      process.env.JWT_SECRET = 'too-short';
      const err = assertJwtSecret();
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/at least 32/);
    });
  });

  it('rejects placeholder JWT_SECRET', () => {
    withCleanEnv(() => {
      process.env.JWT_SECRET = 'change-this-in-production-to-something-secure';
      const err = assertJwtSecret();
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/placeholder/);
    });
  });

  it('rejects repeated-character JWT_SECRET', () => {
    withCleanEnv(() => {
      process.env.JWT_SECRET = 'x'.repeat(48);
      const err = assertJwtSecret();
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/repeated character/);
    });
  });

  it('accepts a strong JWT_SECRET', () => {
    withCleanEnv(() => {
      process.env.JWT_SECRET = strongSecret();
      const err = assertJwtSecret();
      expect(err).toBeNull();
    });
  });

  it('ALLOW_WEAK_JWT_SECRET=1 bypasses the check', () => {
    withCleanEnv(() => {
      process.env.ALLOW_WEAK_JWT_SECRET = '1';
      process.env.JWT_SECRET = 'demo';
      const err = assertJwtSecret();
      expect(err).toBeNull();
    });
  });

  it('JWT_SECRET_LENGTH_MIN lowers the threshold when needed', () => {
    withCleanEnv(() => {
      process.env.JWT_SECRET_LENGTH_MIN = '16';
      process.env.JWT_SECRET = 'sixteen-chars-xx'; // 18 chars
      const err = assertJwtSecret();
      expect(err).toBeNull();
    });
  });

  it('validateJwtSecretOrExit calls exit(1) on a missing secret', () => {
    withCleanEnv(() => {
      const exit = jest.fn();
      validateJwtSecretOrExit(exit as any);
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  it('validateJwtSecretOrExit does NOT call exit on a strong secret', () => {
    withCleanEnv(() => {
      process.env.JWT_SECRET = strongSecret();
      const exit = jest.fn();
      validateJwtSecretOrExit(exit as any);
      expect(exit).not.toHaveBeenCalled();
    });
  });
});

/**
 * SEC-3: Stripe webhook secret enforcement at startup.
 * See docs/security-review-2026-07.md finding 10.
 */
const STRIPE_ENV_KEYS = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'NODE_ENV',
  'ALLOW_UNVERIFIED_STRIPE_WEBHOOK',
];

function withCleanStripeEnv<T>(fn: () => T): T {
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

describe('SEC-3: assertStripeWebhookConfig (L-4)', () => {
  it('passes when Stripe is not configured at all', () => {
    withCleanStripeEnv(() => {
      const err = assertStripeWebhookConfig();
      expect(err).toBeNull();
    });
  });

  it('passes when both STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET are set', () => {
    withCleanStripeEnv(() => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec_abc';
      const err = assertStripeWebhookConfig();
      expect(err).toBeNull();
    });
  });

  it('refuses to boot in production when secret key is set but webhook secret is missing', () => {
    withCleanStripeEnv(() => {
      process.env.NODE_ENV = 'production';
      process.env.STRIPE_SECRET_KEY = 'sk_live_abc';
      // STRIPE_WEBHOOK_SECRET deliberately unset
      const err = assertStripeWebhookConfig();
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/STRIPE_WEBHOOK_SECRET is required/);
      expect(err!.message).toMatch(/production/);
    });
  });

  it('warns but allows dev to boot with secret key set and no webhook secret', () => {
    withCleanStripeEnv(() => {
      const stderr = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      process.env.NODE_ENV = 'development';
      process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
      const err = assertStripeWebhookConfig();
      expect(err).toBeNull();
      stderr.mockRestore();
    });
  });

  it('rejects a webhook secret with the wrong prefix', () => {
    withCleanStripeEnv(() => {
      process.env.STRIPE_SECRET_KEY = 'sk_test_abc';
      process.env.STRIPE_WEBHOOK_SECRET = 'not-a-whsec-value';
      const err = assertStripeWebhookConfig();
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/whsec_/);
    });
  });

  it('ALLOW_UNVERIFIED_STRIPE_WEBHOOK=1 bypasses the production check', () => {
    withCleanStripeEnv(() => {
      process.env.NODE_ENV = 'production';
      process.env.STRIPE_SECRET_KEY = 'sk_live_abc';
      process.env.ALLOW_UNVERIFIED_STRIPE_WEBHOOK = '1';
      const err = assertStripeWebhookConfig();
      expect(err).toBeNull();
    });
  });

  it('validateStripeWebhookConfigOrExit calls exit(1) on a half-configured production deploy', () => {
    withCleanStripeEnv(() => {
      process.env.NODE_ENV = 'production';
      process.env.STRIPE_SECRET_KEY = 'sk_live_abc';
      const exit = jest.fn();
      validateStripeWebhookConfigOrExit(exit as any);
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  it('validateStripeWebhookConfigOrExit does NOT call exit on a healthy config', () => {
    withCleanStripeEnv(() => {
      process.env.NODE_ENV = 'production';
      process.env.STRIPE_SECRET_KEY = 'sk_live_abc';
      process.env.STRIPE_WEBHOOK_SECRET = 'whsec_live_abc';
      const exit = jest.fn();
      validateStripeWebhookConfigOrExit(exit as any);
      expect(exit).not.toHaveBeenCalled();
    });
  });
});
