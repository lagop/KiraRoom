/**
 * The platform email settings set from the console: two-step sign-in to
 * change them, encrypted at rest, never returned, audited without values,
 * and in force at once (no restart).
 */
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { PlatformEmailConfigService } from "./platform-email-config.service";

const key = ["re", "fictitiousKey1234"].join("_");
const otherKey = ["re", "anotherFakeKey987"].join("_");
const webhookSecret = "whsec_" + Buffer.from("fictitious-signing-key").toString("base64");

function build(opts: { twoFactor?: boolean; env?: Record<string, string> } = {}) {
  let row: any = null;
  const prisma = {
    user: {
      findUnique: jest.fn().mockResolvedValue({ twoFactorEnabled: opts.twoFactor ?? true, email: "admin@kiraroom.test" }),
    },
    platformEmailConfig: {
      findUnique: jest.fn(async () => row),
      upsert: jest.fn(async ({ create, update }: any) => {
        row = row ? { ...row, ...update, updatedAt: new Date() } : { ...create, updatedAt: new Date() };
        return row;
      }),
    },
  };
  // Reversible stand-in for AES: enough to tell stored from plain.
  const encryption = {
    encrypt: jest.fn((s: string) => `enc(${s})`),
    decrypt: jest.fn((s: string) => s.replace(/^enc\((.*)\)$/, "$1")),
  };
  const env = opts.env ?? {};
  const config = { get: (k: string) => env[k] };
  const auditLog = { record: jest.fn().mockResolvedValue({ id: "a1" }) };
  const service = new PlatformEmailConfigService(prisma as any, encryption as any, config as any, auditLog as any);
  (service as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { service, prisma, encryption, auditLog, getRow: () => row };
}

const admin = { id: "u1", role: "saas_owner" };

describe("PlatformEmailConfigService", () => {
  it("uses the server's .env until something is set in the console", async () => {
    const { service } = build({ env: { RESEND_API_KEY: otherKey, EMAIL_FROM: "noreply@kiraroom.com" } });
    await service.onModuleInit();
    expect(service.current()).toEqual({ apiKey: otherKey, from: "noreply@kiraroom.com", webhookSecret: null });
    expect(service.getConfig().apiKey).toEqual({ source: "server", lastFour: "y987" });
  });

  it("refuses changes from an account without two-step sign-in", async () => {
    const { service, prisma } = build({ twoFactor: false });
    await expect(service.update({ apiKey: key }, admin)).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.platformEmailConfig.upsert).not.toHaveBeenCalled();
  });

  it("refuses a value that is not a Resend key, with the reason", async () => {
    const { service, prisma } = build();
    await expect(service.update({ apiKey: "sk-ant-oops" }, admin)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update({ from: "notificaciones" }, admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.platformEmailConfig.upsert).not.toHaveBeenCalled();
  });

  it("stores the key and secret encrypted, uses them at once, and never returns them", async () => {
    const { service, getRow } = build({ env: { RESEND_API_KEY: otherKey } });
    await service.onModuleInit();
    const shown = await service.update(
      { apiKey: key, from: "KiraRoom <notificaciones@kiraroom.com>", webhookSecret },
      admin,
    );

    expect(getRow().apiKeyEncrypted).toBe(`enc(${key})`);
    expect(getRow().webhookSecretEncrypted).toBe(`enc(${webhookSecret})`);
    expect(service.current().apiKey).toBe(key);
    expect(service.current().webhookSecret).toBe(webhookSecret);

    const text = JSON.stringify(shown);
    expect(text).not.toContain(key);
    expect(text).not.toContain(webhookSecret);
    expect(shown.apiKey).toEqual({ source: "console", lastFour: "1234" });
    expect(shown.from).toEqual({ source: "console", value: "KiraRoom <notificaciones@kiraroom.com>" });
    expect(shown.updatedBy).toBe("admin@kiraroom.test");
  });

  it("audits which settings changed, never their values", async () => {
    const { service, auditLog } = build();
    await service.update({ apiKey: key, webhookSecret: null }, admin);
    expect(auditLog.record).toHaveBeenCalledWith(
      "platform.email_config.updated",
      expect.objectContaining({ actorId: "u1", metadata: { set: ["apiKey"], cleared: ["webhookSecret"] } }),
    );
    expect(JSON.stringify(auditLog.record.mock.calls)).not.toContain(key);
  });

  it("clearing a setting goes back to the server's", async () => {
    const { service } = build({ env: { RESEND_API_KEY: otherKey } });
    await service.update({ apiKey: key }, admin);
    expect(service.current().apiKey).toBe(key);
    await service.update({ apiKey: null }, admin);
    expect(service.current().apiKey).toBe(otherKey);
    expect(service.getConfig().apiKey.source).toBe("server");
  });

  it("a stored value that cannot be decrypted falls back to the server's", async () => {
    const { service, encryption } = build({ env: { RESEND_API_KEY: otherKey } });
    await service.update({ apiKey: key }, admin);
    encryption.decrypt.mockImplementation(() => {
      throw new Error("bad auth tag");
    });
    await service.onModuleInit();
    expect(service.current().apiKey).toBe(otherKey);
  });

  it("the test email needs a key and a sender", async () => {
    const { service } = build();
    await service.onModuleInit();
    expect(await service.sendTest(admin)).toEqual({ ok: false, message: expect.stringMatching(/clave/) });
  });
});

describe("PlatformEmailConfigService: the bono de emails", () => {
  it("is not offered until both its size and its price are set", async () => {
    const { service, auditLog } = build();
    await service.onModuleInit();
    expect(service.marketingPack()).toBeNull();

    await service.update({ marketingPackEmails: 1000 }, admin);
    expect(service.marketingPack()).toBeNull();
    expect(service.getConfig().marketingPack).toEqual({ emails: 1000, priceCents: null, offered: false });

    await service.update({ marketingPackPriceCents: 1500 }, admin);
    expect(service.marketingPack()).toEqual({ emails: 1000, priceCents: 1500 });
    expect(service.getConfig().marketingPack.offered).toBe(true);
    // Not secret: the audit says what it changed to.
    expect(auditLog.record).toHaveBeenLastCalledWith(
      "platform.email_config.updated",
      expect.objectContaining({ metadata: expect.objectContaining({ marketingPack: { emails: undefined, priceCents: 1500 } }) }),
    );

    await service.update({ marketingPackPriceCents: null }, admin);
    expect(service.marketingPack()).toBeNull();
  });

  it("refuses a size or price out of range, with the reason", async () => {
    const { service, prisma } = build();
    await expect(service.update({ marketingPackEmails: 10 }, admin)).rejects.toThrow(/entre 100 y 100\.000 emails/);
    await expect(service.update({ marketingPackPriceCents: 12.5 }, admin)).rejects.toBeInstanceOf(BadRequestException);
    expect(prisma.platformEmailConfig.upsert).not.toHaveBeenCalled();
  });
});
