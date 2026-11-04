/**
 * KiraRoom's Stripe account set from the console: two-step sign-in to change
 * it, encrypted at rest, never returned, never half-configured, audited
 * without values, and in force at once (no restart). Switching between test
 * and live keeps the old mode's webhook secret for its late events, and
 * shows which salons hold the other mode's customers and subscriptions.
 */
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { PlatformStripeConfigService, redactStripe } from "./platform-stripe-config.service";

// Built at runtime: fictitious values that only look like Stripe's.
const k = (...parts: string[]) => parts.join("_");
const skTest = k("sk", "test", "fictitious0123456789");
const skTest2 = k("sk", "test", "fictitiousSecond0987");
const skLive = k("sk", "live", "fictitious0123456789");
const pkTest = k("pk", "test", "fictitious0123456789");
const pkLive = k("pk", "live", "fictitious0123456789");
const whsec = k("whsec", "fictitious0123456789");
const whsecTest = k("whsec", "fictitiousTestMode01");
const whsecLive = k("whsec", "fictitiousLiveMode01");

function build(opts: { twoFactor?: boolean; env?: Record<string, string>; row?: any } = {}) {
  let row: any = opts.row ?? null;
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ twoFactorEnabled: opts.twoFactor ?? true, email: "admin@kiraroom.test" }),
    },
    platformStripeConfig: {
      findUnique: jest.fn(async () => row),
      upsert: jest.fn(async ({ create, update }: any) => {
        row = row ? { ...row, ...update, updatedAt: new Date() } : { ...create, updatedAt: new Date() };
        return row;
      }),
    },
    tenant: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
  const encryption = {
    encrypt: jest.fn((s: string) => `enc(${s})`),
    decrypt: jest.fn((s: string) => {
      if (!/^enc\(.*\)$/.test(s)) throw new Error("Unsupported state or unable to authenticate data");
      return s.replace(/^enc\((.*)\)$/, "$1");
    }),
  };
  const env = opts.env ?? {};
  const config = { get: (key: string) => env[key] };
  const auditLog = { record: jest.fn().mockResolvedValue({ id: "a1" }) };
  const service = new PlatformStripeConfigService(prisma as any, encryption as any, config as any, auditLog as any);
  (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service, prisma, auditLog, getRow: () => row };
}

const admin = { id: "u1", role: "saas_owner" };
// Production today: test keys in the console over the live ones in .env.
const liveEnv = { STRIPE_SECRET_KEY: skLive, STRIPE_PUBLISHABLE_KEY: pkLive, STRIPE_WEBHOOK_SECRET: whsecLive };
const testConsoleRow = () => ({
  id: "global",
  secretKeyEncrypted: `enc(${skTest})`,
  publishableKey: pkTest,
  webhookSecretEncrypted: `enc(${whsecTest})`,
  otherWebhookSecretEncrypted: null,
  taxEnabled: null,
  updatedAt: new Date(),
  updatedBy: "admin@kiraroom.test",
});

describe("PlatformStripeConfigService", () => {
  it("uses the server's .env until the console has something; Stripe Tax stays off (D6)", async () => {
    const { service } = build({ env: { STRIPE_SECRET_KEY: skTest, STRIPE_WEBHOOK_SECRET: whsec, STRIPE_TAX_ENABLED: "true" } });
    await service.onModuleInit();
    expect(service.current()).toMatchObject({ secretKey: skTest, webhookSecret: whsec, taxEnabled: false });
    expect(service.getConfig()).toMatchObject({ mode: "test", secretKey: { source: "server" }, taxIgnored: true, problem: null });
  });

  it("refuses changes from an account without two-step sign-in", async () => {
    const { service, prisma } = build({ twoFactor: false });
    await expect(service.update({ secretKey: skTest, webhookSecret: whsec }, admin)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.platformStripeConfig.upsert).not.toHaveBeenCalled();
  });

  it("refuses a key in the wrong field", async () => {
    const { service } = build();
    await expect(service.update({ secretKey: pkTest }, admin)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update({ otherWebhookSecret: skTest }, admin)).rejects.toThrow(/whsec_/);
  });

  it("refuses a secret key without a webhook secret, and keys from different modes", async () => {
    const { service, prisma } = build();
    await expect(service.update({ secretKey: skTest }, admin)).rejects.toThrow(/webhook/);
    await expect(service.update({ secretKey: skLive, publishableKey: pkTest, webhookSecret: whsec }, admin)).rejects.toThrow(
      /mismo modo/,
    );
    expect(prisma.platformStripeConfig.upsert).not.toHaveBeenCalled();
  });

  it("refuses the secret key from the console with the webhook secret from .env, and the other way round (P3)", async () => {
    const { service, prisma } = build({ env: { STRIPE_WEBHOOK_SECRET: whsec } });
    await expect(service.update({ secretKey: skTest }, admin)).rejects.toThrow(/mismo sitio/);

    const prod = build({ env: liveEnv, row: testConsoleRow() });
    await prod.service.onModuleInit();
    // Removing only the webhook secret used to be accepted and broke every payment.
    await expect(prod.service.update({ webhookSecret: null }, admin)).rejects.toThrow(/mismo sitio/);
    expect(prisma.platformStripeConfig.upsert).not.toHaveBeenCalled();
    expect(prod.prisma.platformStripeConfig.upsert).not.toHaveBeenCalled();
  });

  it("stores encrypted, uses at once, never returns the secrets", async () => {
    const { service, getRow } = build();
    const shown = await service.update({ secretKey: skTest, publishableKey: pkTest, webhookSecret: whsec }, admin);
    expect(getRow().secretKeyEncrypted).toBe(`enc(${skTest})`);
    expect(getRow().webhookSecretEncrypted).toBe(`enc(${whsec})`);
    expect(service.current()).toMatchObject({ secretKey: skTest, webhookSecret: whsec, taxEnabled: false });

    const text = JSON.stringify(shown);
    expect(text).not.toContain(skTest);
    expect(text).not.toContain(whsec);
    expect(shown).toMatchObject({ mode: "test", publishableKey: { value: pkTest } });
  });

  it("a new key builds a new client; no key, no client", async () => {
    const { service } = build();
    expect(service.client()).toBeNull();
    await service.update({ secretKey: skTest, webhookSecret: whsec }, admin);
    const first = service.client();
    expect(first).not.toBeNull();
    expect(service.client()).toBe(first);
    await service.update({ secretKey: skTest2 }, admin);
    expect(service.client()).not.toBe(first);
  });

  it("audits which settings changed and the mode, never the keys", async () => {
    const { service, auditLog } = build();
    await service.update({ secretKey: skTest, webhookSecret: whsec }, admin);
    expect(auditLog.record).toHaveBeenCalledWith(
      "platform.stripe_config.updated",
      expect.objectContaining({
        metadata: { set: ["secretKey", "webhookSecret"], cleared: [], mode: "test", modeBefore: "none" },
      }),
    );
    expect(JSON.stringify(auditLog.record.mock.calls)).not.toContain(skTest);
  });

  it("«Volver a lo del servidor» clears the three at once: live mode, the test secret kept for test events", async () => {
    const { service, getRow, auditLog } = build({ env: liveEnv, row: testConsoleRow() });
    await service.onModuleInit();
    expect(service.getConfig()).toMatchObject({ mode: "test", server: { mode: "live", hasWebhookSecret: true } });
    // Before: the .env's live secret verifies the late live events.
    expect(service.current().otherWebhookSecret).toBe(whsecLive);

    const preview = await service.preview({ secretKey: null, publishableKey: null, webhookSecret: null });
    expect(preview).toMatchObject({ modeBefore: "test", modeAfter: "live", problem: null });

    const shown = await service.update({ secretKey: null, publishableKey: null, webhookSecret: null }, admin);
    expect(shown).toMatchObject({
      mode: "live",
      secretKey: { source: "server" },
      webhookSecret: { source: "server" },
      otherWebhookSecret: { source: "console", mode: "test" },
    });
    expect(getRow()).toMatchObject({ secretKeyEncrypted: null, webhookSecretEncrypted: null, otherWebhookSecretEncrypted: `enc(${whsecTest})` });
    expect(service.current()).toMatchObject({ secretKey: skLive, webhookSecret: whsecLive, otherWebhookSecret: whsecTest });
    expect(auditLog.record.mock.calls[0][1].metadata).toMatchObject({ mode: "live", modeBefore: "test" });
  });

  it("switching back with the other mode's secret stored swaps the two secrets", async () => {
    const { service, getRow } = build();
    await service.update({ secretKey: skTest, publishableKey: pkTest, webhookSecret: whsecTest }, admin);
    await service.update({ secretKey: skLive, publishableKey: pkLive, webhookSecret: whsecLive }, admin);
    expect(service.current()).toMatchObject({ webhookSecret: whsecLive, otherWebhookSecret: whsecTest });
    // Back to test without typing a webhook secret: the stored test one.
    await service.update({ secretKey: skTest, publishableKey: pkTest }, admin);
    expect(service.current()).toMatchObject({ secretKey: skTest, webhookSecret: whsecTest, otherWebhookSecret: whsecLive });
    expect(getRow().webhookSecretEncrypted).toBe(`enc(${whsecTest})`);
  });

  it("refuses switching modes while keeping the old mode's webhook secret", async () => {
    const { service } = build();
    await service.update({ secretKey: skTest, publishableKey: pkTest, webhookSecret: whsecTest }, admin);
    await expect(service.update({ secretKey: skLive, publishableKey: pkLive }, admin)).rejects.toThrow(/modo real, pega también/);
  });

  it("a stored value that cannot be decrypted leaves Stripe unconfigured, not on the .env's keys (P4)", async () => {
    const row = { ...testConsoleRow(), secretKeyEncrypted: "v2.garbage.from.another-key" };
    const { service } = build({ env: liveEnv, row });
    await service.onModuleInit();
    expect(service.current().secretKey).toBeNull();
    expect(service.client()).toBeNull();
    const shown = service.getConfig();
    expect(shown).toMatchObject({ mode: "none", secretKey: { source: "unreadable" } });
    expect(shown.problem).toMatch(/no se puede descifrar/i);
    // Fixed by typing it again.
    await service.update({ secretKey: skTest }, admin);
    expect(service.getConfig()).toMatchObject({ mode: "test", problem: null });
  });

  it("reports a mix in force that saving would refuse (a .env changed under the console)", async () => {
    const row = { ...testConsoleRow(), secretKeyEncrypted: null, publishableKey: null };
    const { service } = build({ env: liveEnv, row });
    await service.onModuleInit();
    expect(service.getConfig().problem).toMatch(/mismo sitio/);
  });

  it("on a mode change the preview lists the salons left with the other mode's data", async () => {
    const { service, prisma } = build({ env: liveEnv, row: testConsoleRow() });
    await service.onModuleInit();
    prisma.tenant.count.mockResolvedValueOnce(3).mockResolvedValueOnce(1);
    prisma.tenant.findMany.mockResolvedValueOnce([
      { id: "t1", name: "Salón Lucía", slug: "lucia", plan: "pro", subscriptionStatus: "active" },
    ]);
    const preview = await service.preview({ secretKey: null, publishableKey: null, webhookSecret: null });
    expect(preview.impact).toEqual({
      otherModeSalons: 3,
      activePlansTotal: 1,
      activePlans: [{ id: "t1", name: "Salón Lucía", slug: "lucia", plan: "pro", subscriptionStatus: "active" }],
    });
    // Going live: test-mode rows (livemode false) and unknown ones are the other mode's.
    expect(prisma.tenant.count.mock.calls[1][0].where).toMatchObject({
      stripeSubscriptionId: { not: null },
      OR: [{ stripeSubscriptionLivemode: false }, { stripeSubscriptionLivemode: null }],
    });
    // No mode change, no impact.
    expect((await service.preview({ publishableKey: pkTest })).impact).toBeNull();
  });

  it("the connection test needs a key, and checks a typed one before calling Stripe", async () => {
    const { service } = build();
    await service.onModuleInit();
    expect(await service.testConnection()).toEqual({ ok: false, message: expect.stringMatching(/clave secreta/) });
    expect(await service.testConnection(pkTest)).toEqual({ ok: false, message: expect.stringMatching(/sk_test_/) });
  });

  it("keys never reach an error message", () => {
    expect(redactStripe(`Invalid API Key provided: ${skLive}`)).toBe("Invalid API Key provided: sk_live_***");
  });
});
