import { validateJwtSecretOrExit, assertJwtSecret } from './main';

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
