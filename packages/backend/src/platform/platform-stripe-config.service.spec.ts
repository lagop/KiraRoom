/**
 * KiraRoom's Stripe account set from the console: two-step sign-in to change
 * it, encrypted at rest, never returned, never half-configured, audited
 * without values, and in force at once (no restart).
 */
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { PlatformStripeConfigService, redactStripe } from "./platform-stripe-config.service";

// Built at runtime: fictitious values that only look like Stripe's.
const k = (...parts: string[]) => parts.join("_");
const skTest = k("sk", "test", "fictitious0123456789");
const skTest2 = k("sk", "test", "fictitiousSecond0987");
const skLive = k("sk", "live", "fictitious0123456789");
const pkTest = k("pk", "test", "fictitious0123456789");
const whsec = k("whsec", "fictitious0123456789");

function build(opts: { twoFactor?: boolean; env?: Record<string, string> } = {}) {
  let row: any = null;
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
  };
  const encryption = {
    encrypt: jest.fn((s: string) => `enc(${s})`),
    decrypt: jest.fn((s: string) => s.replace(/^enc\((.*)\)$/, "$1")),
  };
  const env = opts.env ?? {};
  const config = { get: (key: string) => env[key] };
  const auditLog = { record: jest.fn().mockResolvedValue({ id: "a1" }) };
  const service = new PlatformStripeConfigService(prisma as any, encryption as any, config as any, auditLog as any);
  (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service, prisma, auditLog, getRow: () => row };
}

const admin = { id: "u1", role: "saas_owner" };

describe("PlatformStripeConfigService", () => {
  it("uses the server's .env until the console has something", async () => {
    const { service } = build({ env: { STRIPE_SECRET_KEY: skTest, STRIPE_WEBHOOK_SECRET: whsec, STRIPE_TAX_ENABLED: "true" } });
    await service.onModuleInit();
    expect(service.current()).toMatchObject({ secretKey: skTest, webhookSecret: whsec, taxEnabled: true });
    expect(service.getConfig()).toMatchObject({ mode: "test", secretKey: { source: "server" }, taxEnabled: { source: "server", value: true } });
  });

  it("refuses changes from an account without two-step sign-in", async () => {
    const { service, prisma } = build({ twoFactor: false });
    await expect(service.update({ secretKey: skTest, webhookSecret: whsec }, admin)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.platformStripeConfig.upsert).not.toHaveBeenCalled();
  });

  it("refuses a key in the wrong field", async () => {
    const { service } = build();
    await expect(service.update({ secretKey: pkTest }, admin)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("refuses a secret key without a webhook secret, and keys from different modes", async () => {
    const { service, prisma } = build();
    await expect(service.update({ secretKey: skTest }, admin)).rejects.toThrow(/webhook/);
    await expect(service.update({ secretKey: skLive, publishableKey: pkTest, webhookSecret: whsec }, admin)).rejects.toThrow(
      /mismo modo/,
    );
    expect(prisma.platformStripeConfig.upsert).not.toHaveBeenCalled();
  });

  it("a webhook secret already in .env is enough for a secret key from the console", async () => {
    const { service } = build({ env: { STRIPE_WEBHOOK_SECRET: whsec } });
    const shown = await service.update({ secretKey: skTest }, admin);
    expect(shown.mode).toBe("test");
    expect(shown.webhookSecret.source).toBe("server");
  });

  it("stores encrypted, uses at once, never returns the secrets", async () => {
    const { service, getRow } = build();
    const shown = await service.update({ secretKey: skTest, publishableKey: pkTest, webhookSecret: whsec, taxEnabled: true }, admin);
    expect(getRow().secretKeyEncrypted).toBe(`enc(${skTest})`);
    expect(getRow().webhookSecretEncrypted).toBe(`enc(${whsec})`);
    expect(service.current()).toMatchObject({ secretKey: skTest, webhookSecret: whsec, taxEnabled: true });

    const text = JSON.stringify(shown);
    expect(text).not.toContain(skTest);
    expect(text).not.toContain(whsec);
    expect(shown).toMatchObject({ mode: "test", publishableKey: { value: pkTest }, taxEnabled: { source: "console", value: true } });
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
    await service.update({ secretKey: skTest, webhookSecret: whsec, taxEnabled: false }, admin);
    expect(auditLog.record).toHaveBeenCalledWith(
      "platform.stripe_config.updated",
      expect.objectContaining({
        metadata: { set: ["secretKey", "webhookSecret", "taxEnabled"], cleared: [], mode: "test", taxEnabled: false },
      }),
    );
    expect(JSON.stringify(auditLog.record.mock.calls)).not.toContain(skTest);
  });

  it("clearing goes back to .env", async () => {
    const { service } = build({ env: { STRIPE_SECRET_KEY: skLive, STRIPE_WEBHOOK_SECRET: whsec } });
    await service.update({ secretKey: skTest }, admin);
    expect(service.getConfig().mode).toBe("test");
    await service.update({ secretKey: null }, admin);
    expect(service.getConfig().mode).toBe("live");
    expect(service.getConfig().secretKey.source).toBe("server");
  });

  it("the connection test needs a key", async () => {
    const { service } = build();
    await service.onModuleInit();
    expect(await service.testConnection()).toEqual({ ok: false, message: expect.stringMatching(/clave secreta/) });
  });

  it("keys never reach an error message", () => {
    expect(redactStripe(`Invalid API Key provided: ${skLive}`)).toBe("Invalid API Key provided: sk_live_***");
  });
});
