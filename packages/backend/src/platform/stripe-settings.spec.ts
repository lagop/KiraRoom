/**
 * Which Stripe settings apply (console, else the server's .env), and the
 * checks on what the admin types in the console.
 */
import {
  keyMode,
  publishableKeyProblem,
  resolveStripeSettings,
  secretKeyProblem,
  stripeConsistencyProblem,
  stripeWebhookSecretProblem,
} from "./stripe-settings";

// Built at runtime: fictitious values that only look like Stripe's.
const k = (...parts: string[]) => parts.join("_");
const skTest = k("sk", "test", "fictitious0123456789");
const skLive = k("sk", "live", "fictitious0123456789");
const pkTest = k("pk", "test", "fictitious0123456789");
const pkLive = k("pk", "live", "fictitious0123456789");
const whsec = k("whsec", "fictitious0123456789");

describe("resolveStripeSettings", () => {
  it("prefers the console, falls back to .env, field by field", () => {
    const s = resolveStripeSettings(
      { secretKey: skLive, webhookSecret: whsec },
      { secretKey: skTest, publishableKey: pkTest, taxEnabled: "true" },
    );
    expect(s.secretKey).toBe(skLive);
    expect(s.publishableKey).toBe(pkTest);
    expect(s.taxEnabled).toBe(true);
    expect(s.sources).toEqual({ secretKey: "console", publishableKey: "server", webhookSecret: "console", taxEnabled: "server" });
  });

  it("tax set in the console wins, also when it is off", () => {
    const s = resolveStripeSettings({ taxEnabled: false }, { taxEnabled: "1" });
    expect(s.taxEnabled).toBe(false);
    expect(s.sources.taxEnabled).toBe("console");
  });

  it("nothing anywhere: no keys and no tax", () => {
    const s = resolveStripeSettings({}, {});
    expect(s.secretKey).toBeNull();
    expect(s.taxEnabled).toBe(false);
    expect(s.sources.taxEnabled).toBe("none");
  });
});

describe("what the admin pastes", () => {
  it("reads the mode from the key", () => {
    expect(keyMode(skTest)).toBe("test");
    expect(keyMode(pkLive)).toBe("live");
    expect(keyMode(null)).toBe("none");
  });

  it("expects a secret key, a publishable key and a webhook secret, each in its field", () => {
    expect(secretKeyProblem(skTest)).toBeNull();
    expect(secretKeyProblem(pkTest)).toMatch(/sk_test_/);
    expect(publishableKeyProblem(pkLive)).toBeNull();
    expect(publishableKeyProblem(skLive)).toMatch(/pk_/);
    expect(stripeWebhookSecretProblem(whsec)).toBeNull();
    expect(stripeWebhookSecretProblem(skLive)).toMatch(/whsec_/);
  });
});

describe("stripeConsistencyProblem", () => {
  const base = { secretKey: null, publishableKey: null, webhookSecret: null, taxEnabled: false };

  it("a secret key needs the webhook secret", () => {
    expect(stripeConsistencyProblem({ ...base, secretKey: skTest })).toMatch(/webhook/);
    expect(stripeConsistencyProblem({ ...base, secretKey: skTest, webhookSecret: whsec })).toBeNull();
  });

  it("both keys from the same mode", () => {
    expect(stripeConsistencyProblem({ ...base, secretKey: skLive, publishableKey: pkTest, webhookSecret: whsec })).toMatch(/mismo modo/);
    expect(stripeConsistencyProblem({ ...base, secretKey: skLive, publishableKey: pkLive, webhookSecret: whsec })).toBeNull();
  });

  it("nothing set is consistent (Stripe simply off)", () => {
    expect(stripeConsistencyProblem(base)).toBeNull();
  });
});
