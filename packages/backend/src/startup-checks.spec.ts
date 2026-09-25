import {
  validateJwtSecretOrExit,
  assertJwtSecret,
  assertJwtRefreshSecret,
  validateJwtRefreshSecretOrExit,
  assertStripeWebhookConfig,
  validateStripeWebhookConfigOrExit,
  assertOAuthStateSecret,
  validateOAuthStateSecretOrExit,
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

/**
 * OAUTH_STATE_SECRET: boot-time validator for the accounting OAuth
 * state-signing key (Holded, Sage, A3, NCS). See
 * packages/backend/src/accounting/accounting.controller.ts for the
 * controller-level defense-in-depth check.
 */
const OAUTH_ENV_KEYS = [
  'OAUTH_STATE_SECRET',
  'NODE_ENV',
  'ALLOW_WEAK_OAUTH_STATE_SECRET',
];

function withCleanOAuthEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of OAUTH_ENV_KEYS) saved[k] = process.env[k];
  for (const k of OAUTH_ENV_KEYS) delete process.env[k];
  try {
    return fn();
  } finally {
    for (const k of OAUTH_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

describe('OAUTH_STATE_SECRET startup validator', () => {
  it('passes in production with a 16+ char random secret', () => {
    withCleanOAuthEnv(() => {
      process.env.NODE_ENV = 'production';
      process.env.OAUTH_STATE_SECRET = 'a-strong-random-secret-of-32+chars';
      const err = assertOAuthStateSecret();
      expect(err).toBeNull();
    });
  });

  it('warns but allows dev to boot with no secret', () => {
    withCleanOAuthEnv(() => {
      const stderr = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      process.env.NODE_ENV = 'development';
      const err = assertOAuthStateSecret();
      expect(err).toBeNull();
      stderr.mockRestore();
    });
  });

  it('warns but allows dev to boot with a short secret', () => {
    withCleanOAuthEnv(() => {
      const stderr = jest
        .spyOn(process.stderr, 'write')
        .mockImplementation(() => true);
      process.env.NODE_ENV = 'development';
      process.env.OAUTH_STATE_SECRET = 'short';
      const err = assertOAuthStateSecret();
      expect(err).toBeNull();
      stderr.mockRestore();
    });
  });

  it('refuses to boot in production when OAUTH_STATE_SECRET is missing', () => {
    withCleanOAuthEnv(() => {
      process.env.NODE_ENV = 'production';
      const err = assertOAuthStateSecret();
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/OAUTH_STATE_SECRET is required/);
      expect(err!.message).toMatch(/production/);
    });
  });

  it('refuses to boot in production when OAUTH_STATE_SECRET is too short', () => {
    withCleanOAuthEnv(() => {
      process.env.NODE_ENV = 'production';
      process.env.OAUTH_STATE_SECRET = 'tooshort'; // 8 chars, well below 16
      const err = assertOAuthStateSecret();
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/at least 16/);
    });
  });

  it('rejects the controller dev fallback if it ever leaks into .env', () => {
    withCleanOAuthEnv(() => {
      process.env.NODE_ENV = 'production';
      process.env.OAUTH_STATE_SECRET =
        'dev-oauth-secret-do-not-use-in-production-and-32-chars';
      const err = assertOAuthStateSecret();
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/placeholder/);
    });
  });

  it('rejects a placeholder value in production', () => {
    withCleanOAuthEnv(() => {
      process.env.NODE_ENV = 'production';
      process.env.OAUTH_STATE_SECRET = 'change-this-before-production-use';
      const err = assertOAuthStateSecret();
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/placeholder/);
    });
  });

  it('rejects a repeated-character secret in production', () => {
    withCleanOAuthEnv(() => {
      process.env.NODE_ENV = 'production';
      process.env.OAUTH_STATE_SECRET = 'x'.repeat(24);
      const err = assertOAuthStateSecret();
      expect(err).not.toBeNull();
      expect(err!.message).toMatch(/repeated character/);
    });
  });

  it('ALLOW_WEAK_OAUTH_STATE_SECRET=1 bypasses the production check', () => {
    withCleanOAuthEnv(() => {
      process.env.NODE_ENV = 'production';
      process.env.OAUTH_STATE_SECRET = 'short';
      process.env.ALLOW_WEAK_OAUTH_STATE_SECRET = '1';
      const err = assertOAuthStateSecret();
      expect(err).toBeNull();
    });
  });

  it('validateOAuthStateSecretOrExit calls exit(1) on a missing secret in production', () => {
    withCleanOAuthEnv(() => {
      process.env.NODE_ENV = 'production';
      const exit = jest.fn();
      validateOAuthStateSecretOrExit(exit as any);
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  it('validateOAuthStateSecretOrExit does NOT call exit on a healthy config', () => {
    withCleanOAuthEnv(() => {
      process.env.NODE_ENV = 'production';
      process.env.OAUTH_STATE_SECRET = 'a-strong-random-secret-of-32+chars';
      const exit = jest.fn();
      validateOAuthStateSecretOrExit(exit as any);
      expect(exit).not.toHaveBeenCalled();
    });
  });
});

/**
 * SEC-7: refresh tokens must not be signed with the access-token key.
 *
 * The production symptom was JWT_REFRESH_SECRET never reaching the
 * container, which makes @nestjs/jwt fall back to JWT_SECRET and lets any
 * access token be redeemed at POST /auth/refresh. These cases pin the
 * validator that now refuses to boot in that state.
 */

const REFRESH_ENV_KEYS = [
  'JWT_SECRET',
  'JWT_REFRESH_SECRET',
  'JWT_SECRET_LENGTH_MIN',
  'ALLOW_WEAK_JWT_SECRET',
  'NODE_ENV',
];

function withCleanRefreshEnv<T>(fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of REFRESH_ENV_KEYS) saved[k] = process.env[k];
  for (const k of REFRESH_ENV_KEYS) delete process.env[k];
  try {
    return fn();
  } finally {
    for (const k of REFRESH_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const STRONG_A = 'wKq4pM2vX8rT6yB1nZ5cL9jH3dF7sG0aQeRtYuIoPaSdFgHj';
const STRONG_B = 'zXcVbNmAsDfGhJkLqWeRtYuIoP1234567890AbCdEfGhIjKl';

describe('SEC-7: assertJwtRefreshSecret (L-4)', () => {
  it('refuses to boot in production when JWT_REFRESH_SECRET is missing', () => {
    withCleanRefreshEnv(() => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = STRONG_A;
      const err = assertJwtRefreshSecret();
      expect(err).toBeInstanceOf(Error);
      expect(err?.message).toContain('JWT_REFRESH_SECRET is required');
      // The message has to explain the consequence, not just the gap.
      expect(err?.message).toContain('/auth/refresh');
    });
  });

  it('warns but boots outside production when it is missing', () => {
    withCleanRefreshEnv(() => {
      process.env.NODE_ENV = 'development';
      process.env.JWT_SECRET = STRONG_A;
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      expect(assertJwtRefreshSecret()).toBeNull();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('JWT_REFRESH_SECRET is not set'),
      );
      warn.mockRestore();
    });
  });

  it('rejects a refresh secret identical to JWT_SECRET, in any environment', () => {
    for (const env of ['production', 'development']) {
      withCleanRefreshEnv(() => {
        process.env.NODE_ENV = env;
        process.env.JWT_SECRET = STRONG_A;
        process.env.JWT_REFRESH_SECRET = STRONG_A;
        const err = assertJwtRefreshSecret();
        expect(err).toBeInstanceOf(Error);
        expect(err?.message).toContain('must differ from JWT_SECRET');
      });
    }
  });

  it('rejects a short refresh secret in production', () => {
    withCleanRefreshEnv(() => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = STRONG_A;
      process.env.JWT_REFRESH_SECRET = 'tooshort';
      expect(assertJwtRefreshSecret()?.message).toContain('at least 32 characters');
    });
  });

  it('rejects a placeholder refresh secret', () => {
    withCleanRefreshEnv(() => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = STRONG_A;
      process.env.JWT_REFRESH_SECRET = 'change-this-refresh-secret-before-deploying';
      expect(assertJwtRefreshSecret()?.message).toContain('placeholder');
    });
  });

  it('accepts a distinct strong refresh secret in production', () => {
    withCleanRefreshEnv(() => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = STRONG_A;
      process.env.JWT_REFRESH_SECRET = STRONG_B;
      expect(assertJwtRefreshSecret()).toBeNull();
    });
  });

  it('honours the ALLOW_WEAK_JWT_SECRET escape hatch that CI already sets', () => {
    withCleanRefreshEnv(() => {
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_WEAK_JWT_SECRET = '1';
      expect(assertJwtRefreshSecret()).toBeNull();
    });
  });

  it('exits the process when the check fails', () => {
    withCleanRefreshEnv(() => {
      process.env.NODE_ENV = 'production';
      process.env.JWT_SECRET = STRONG_A;
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      const exit = jest.fn();
      validateJwtRefreshSecretOrExit(exit as unknown as typeof process.exit);
      expect(exit).toHaveBeenCalledWith(1);
      error.mockRestore();
    });
  });
});
