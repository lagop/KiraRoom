/**
 * Which Stripe settings apply (console, else the server's .env), and the
 * checks on what the admin types in the console.
 */
import {
  keyMode,
  publishableKeyProblem,
  resolveStripeSettings,
  sameStripeMode,
  secretKeyProblem,
  stripeConsistencyProblem,
  stripeWebhookSecretProblem,
  webhookSecretsFor,
} from "./stripe-settings";

// Built at runtime: fictitious values that only look like Stripe's.
const k = (...parts: string[]) => parts.join("_");
const skTest = k("sk", "test", "fictitious0123456789");
const skLive = k("sk", "live", "fictitious0123456789");
const pkTest = k("pk", "test", "fictitious0123456789");
const pkLive = k("pk", "live", "fictitious0123456789");
const whsec = k("whsec", "fictitious0123456789");
const whsecOther = k("whsec", "fictitiousOther01234");

describe("resolveStripeSettings", () => {
  it("prefers the console, falls back to .env, field by field", () => {
    const s = resolveStripeSettings(
      { secretKey: skLive, webhookSecret: whsec },
      { secretKey: skTest, publishableKey: pkTest },
    );
    expect(s.secretKey).toBe(skLive);
    expect(s.publishableKey).toBe(pkTest);
    expect(s.sources).toEqual({ secretKey: "console", publishableKey: "server", webhookSecret: "console", otherWebhookSecret: "none" });
  });

  it("Stripe Tax is always off (D6); asking for it is reported", () => {
    expect(resolveStripeSettings({ taxEnabled: true }, {})).toMatchObject({ taxEnabled: false, taxIgnored: true });
    expect(resolveStripeSettings({}, { taxEnabled: "1" })).toMatchObject({ taxEnabled: false, taxIgnored: true });
    expect(resolveStripeSettings({ taxEnabled: false }, { taxEnabled: "1" })).toMatchObject({ taxEnabled: false, taxIgnored: false });
  });

  it("nothing anywhere: no keys", () => {
    const s = resolveStripeSettings({}, {});
    expect(s.secretKey).toBeNull();
    expect(s.taxEnabled).toBe(false);
  });

  it("a value that cannot be decrypted is not replaced by the .env's", () => {
    const s = resolveStripeSettings({ webhookSecret: whsec }, { secretKey: skLive }, { secretKey: true });
    expect(s.secretKey).toBeNull();
    expect(s.sources.secretKey).toBe("unreadable");
  });

  it("the .env's webhook secret is the other mode's when the console holds the other mode's keys", () => {
    const s = resolveStripeSettings({ secretKey: skTest, webhookSecret: whsec }, { secretKey: skLive, webhookSecret: whsecOther });
    expect(s.otherWebhookSecret).toBe(whsecOther);
    expect(s.sources.otherWebhookSecret).toBe("server");
    // Same mode in both: no other mode's secret.
    expect(resolveStripeSettings({ secretKey: skTest, webhookSecret: whsec }, { secretKey: skTest, webhookSecret: whsecOther }).otherWebhookSecret).toBeNull();
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
  const base = { secretKey: null, publishableKey: null, webhookSecret: null, otherWebhookSecret: null, taxEnabled: false };

  it("a secret key needs the webhook secret", () => {
    expect(stripeConsistencyProblem({ ...base, secretKey: skTest })).toMatch(/webhook/);
    expect(stripeConsistencyProblem({ ...base, secretKey: skTest, webhookSecret: whsec })).toBeNull();
  });

  it("both keys from the same mode", () => {
    expect(stripeConsistencyProblem({ ...base, secretKey: skLive, publishableKey: pkTest, webhookSecret: whsec })).toMatch(/mismo modo/);
    expect(stripeConsistencyProblem({ ...base, secretKey: skLive, publishableKey: pkLive, webhookSecret: whsec })).toBeNull();
  });

  it("the secret key and its webhook secret from the same place", () => {
    const s = { ...base, secretKey: skLive, webhookSecret: whsec };
    expect(stripeConsistencyProblem(s, { secretKey: "server", webhookSecret: "console" })).toMatch(/mismo sitio/);
    expect(stripeConsistencyProblem(s, { secretKey: "console", webhookSecret: "console" })).toBeNull();
  });

  it("a stored value that cannot be read is a problem", () => {
    expect(stripeConsistencyProblem(base, { secretKey: "unreadable" })).toMatch(/clave secreta/);
    expect(stripeConsistencyProblem(base, { otherWebhookSecret: "unreadable" })).toMatch(/otro modo/);
  });

  it("nothing set is consistent (Stripe simply off)", () => {
    expect(stripeConsistencyProblem(base)).toBeNull();
  });
});

describe("webhook secrets and modes", () => {
  const s = { secretKey: skTest, publishableKey: null, webhookSecret: whsec, otherWebhookSecret: whsecOther, taxEnabled: false };

  it("tries the secret of the event's mode first", () => {
    expect(webhookSecretsFor(s, false)).toEqual([whsec, whsecOther]);
    expect(webhookSecretsFor(s, true)).toEqual([whsecOther, whsec]);
    expect(webhookSecretsFor({ ...s, otherWebhookSecret: null }, true)).toEqual([whsec]);
  });

  it("an unknown mode matches anything; a known one only itself", () => {
    expect(sameStripeMode(null, true)).toBe(true);
    expect(sameStripeMode(false, null)).toBe(true);
    expect(sameStripeMode(false, true)).toBe(false);
    expect(sameStripeMode(true, true)).toBe(true);
  });
});
