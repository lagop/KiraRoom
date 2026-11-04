/**
 * Test doubles for the captcha and the Redis limits: everything allowed,
 * captcha off. For specs that build AuthController by hand.
 */
export function noTurnstile(): any {
  return { isEnabled: jest.fn(() => false), verify: jest.fn(async () => "ok") };
}

export function noLimits(): any {
  return {
    signupAttempt: jest.fn(async () => null),
    allowPasswordResetEmail: jest.fn(async () => true),
    allowVerificationResend: jest.fn(async () => true),
    loginNeedsCaptcha: jest.fn(async () => false),
    loginFailed: jest.fn(async () => false),
    loginSucceeded: jest.fn(async () => undefined),
  };
}
