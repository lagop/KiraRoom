import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { PlatformLlmConfigService, StoredLlmKeyUnreadableError } from "./platform-llm-config.service";
import { TestPlatformLlmConfigDto, UpdatePlatformLlmConfigDto } from "./platform-llm-config.dto";

/**
 * L-4 unit tests for PlatformLlmConfigService.
 *
 * The service handles encrypted-at-rest API keys. These tests pin:
 *   - Upsert + last-4-chars masking
 *   - Provider name normalization (case-insensitive, enum-mapped)
 *   - Sanitization of provider error messages (no plaintext keys leak)
 *   - Behavior when the row is absent (returns null from resolve)
 *   - "Empty apiKey = keep existing" semantics
 */

function makePrisma(opts: {
  row?: any;
  twoFactor?: boolean;
}) {
  return {
    user: {
      findUnique: jest.fn().mockResolvedValue({ twoFactorEnabled: opts.twoFactor ?? true, email: "admin@kiraroom.test" }),
    },
    platformLlmConfig: {
      update: jest.fn().mockImplementation(async ({ data }) => ({ ...opts.row, ...data, updatedAt: new Date() })),
      findUnique: jest.fn().mockImplementation(async ({ where }) => {
        if (where.id === "global" && opts.row) return opts.row;
        return null;
      }),
      upsert: jest.fn().mockImplementation(async ({ where, create, update }) => {
        // P2A-platform-llm: simulate the persisted row that comes back
        // from Prisma — includes auto-managed `updatedAt` and merges the
        // create/update payloads.
        return {
          id: "global",
          provider: update?.provider ?? create?.provider ?? "anthropic",
          defaultModel:
            update?.defaultModel ?? create?.defaultModel ?? "claude-haiku-4-5",
          baseUrl: update?.baseUrl ?? create?.baseUrl ?? null,
          apiKeyEncrypted:
            update?.apiKeyEncrypted ?? create?.apiKeyEncrypted ?? "",
          updatedBy: update?.updatedBy ?? create?.updatedBy ?? null,
          updatedAt: new Date(),
        };
      }),
    },
  };
}

function makeEncryption() {
  return {
    encrypt: jest.fn((plain: string) => `enc:${plain}`),
    decrypt: jest.fn((packed: string) => packed.replace(/^enc:/, "")),
    hashIp: jest.fn((s: string) => `hash:${s.length}`),
  } as any;
}

const REAL_ROW = {
  id: "global",
  provider: "anthropic",
  apiKeyEncrypted: "enc:sk-ant-api03-real-key-1234abcd",
  defaultModel: "claude-haiku-4-5",
  baseUrl: null,
  updatedAt: new Date("2026-08-30T10:00:00Z"),
  updatedBy: "admin-1",
};

describe("PlatformLlmConfigService (L-4)", () => {
  describe("getConfig", () => {
    it("returns the public view (masked key) when a row exists", async () => {
      const prisma = makePrisma({ row: REAL_ROW });
      const encryption = makeEncryption();
      const svc = new PlatformLlmConfigService(prisma as any, encryption, {} as any);

      const view = await svc.getConfig();
      expect(view.provider).toBe("anthropic");
      expect(view.defaultModel).toBe("claude-haiku-4-5");
      expect(view.hasKey).toBe(true);
      expect(view.apiKeyLastFour).toBe("abcd");
      expect(view.apiKeyMasked).toContain("abcd");
      expect(view.apiKeyMasked).not.toBe("sk-ant-api03-real-key-1234abcd");
      expect(view.updatedAt).toBe("2026-08-30T10:00:00.000Z");
    });

    it("returns an empty config when no row exists", async () => {
      const prisma = makePrisma({});
      const svc = new PlatformLlmConfigService(prisma as any, makeEncryption(), {} as any);

      const view = await svc.getConfig();
      expect(view.hasKey).toBe(false);
      expect(view.provider).toBe("anthropic");
      expect(view.apiKeyLastFour).toBe("");
      expect(view.updatedAt).toBeNull();
      // The model production runs; Haiku 4.5 is legacy.
      expect(view.defaultModel).toBe("claude-haiku-5-5");
    });
  });

  const admin = { id: "u1", role: "saas_owner" };

  describe("updateConfig", () => {
    it("needs two-step sign-in, and audits the change without the key (P5)", async () => {
      const blocked = makePrisma({ twoFactor: false });
      const svc1 = new PlatformLlmConfigService(blocked as any, makeEncryption(), {} as any);
      await expect(svc1.updateConfig({ apiKey: "sk-ant-api03-new-key-9999" }, admin)).rejects.toThrow(/dos pasos/);
      expect(blocked.platformLlmConfig.upsert).not.toHaveBeenCalled();

      const prisma = makePrisma({});
      const auditLog = { record: jest.fn().mockResolvedValue({}) };
      const svc = new PlatformLlmConfigService(prisma as any, makeEncryption(), {} as any, auditLog as any);
      await svc.updateConfig({ apiKey: "sk-ant-api03-new-key-9999", defaultModel: "claude-haiku-5-5" }, admin);
      expect(auditLog.record).toHaveBeenCalledWith(
        "platform.llm_config.updated",
        expect.objectContaining({ actorId: "u1", metadata: expect.objectContaining({ set: ["defaultModel", "apiKey"] }) }),
      );
      expect(JSON.stringify(auditLog.record.mock.calls)).not.toContain("new-key");
    });

    it("«Quitar» removes the console's key: the .env applies again", async () => {
      const prisma = makePrisma({ row: REAL_ROW });
      const encryption = makeEncryption();
      const svc = new PlatformLlmConfigService(prisma as any, encryption, {} as any);
      const view = await svc.clearApiKey(admin);
      expect(prisma.platformLlmConfig.update.mock.calls[0][0].data.apiKeyEncrypted).toBe("enc:");
      expect(view).toMatchObject({ hasKey: false, keyState: "none" });
    });

    it("creates the row with Claude Haiku 5.5 when no model is given", async () => {
      const prisma = makePrisma({});
      const svc = new PlatformLlmConfigService(prisma as any, makeEncryption(), {} as any);
      await svc.updateConfig({ provider: "anthropic", apiKey: "test-key-not-real-0000" }, admin);
      const upsertArg = prisma.platformLlmConfig.upsert.mock.calls[0][0];
      expect(upsertArg.create.defaultModel).toBe("claude-haiku-5-5");
    });

    it("encrypts a new apiKey before persisting", async () => {
      const prisma = makePrisma({});
      const encryption = makeEncryption();
      const svc = new PlatformLlmConfigService(prisma as any, encryption, {} as any);

      await svc.updateConfig(
        {
          provider: "anthropic",
          apiKey: "sk-ant-api03-new-key-9999",
          defaultModel: "claude-haiku-4-5",
        },
        admin,
      );

      expect(encryption.encrypt).toHaveBeenCalledWith("sk-ant-api03-new-key-9999");
      const upsertArg = prisma.platformLlmConfig.upsert.mock.calls[0][0];
      expect(upsertArg.create.apiKeyEncrypted).toBe("enc:sk-ant-api03-new-key-9999");
      // Who changed it: the account's email, as on the email and Stripe pages.
      expect(upsertArg.create.updatedBy).toBe("admin@kiraroom.test");
    });

    it("does not overwrite the key when apiKey is empty (keep existing)", async () => {
      const prisma = makePrisma({ row: REAL_ROW });
      const encryption = makeEncryption();
      const svc = new PlatformLlmConfigService(prisma as any, encryption, {} as any);

      encryption.encrypt.mockClear();
      await svc.updateConfig({ defaultModel: "claude-sonnet-5-5" }, admin);

      expect(encryption.encrypt).not.toHaveBeenCalled();
      // The update object should NOT contain apiKeyEncrypted.
      const upsertArg = prisma.platformLlmConfig.upsert.mock.calls[0][0];
      expect(upsertArg.update).not.toHaveProperty("apiKeyEncrypted");
      expect(upsertArg.update.defaultModel).toBe("claude-sonnet-5-5");
    });
  });

  describe("resolveEffective", () => {
    it("maps 'anthropic' to LLMProvider.ANTHROPIC", async () => {
      const prisma = makePrisma({ row: REAL_ROW });
      const svc = new PlatformLlmConfigService(prisma as any, makeEncryption(), {} as any);

      const eff = await svc.resolveEffective();
      expect(eff?.provider).toBe("anthropic");
      expect(eff?.model).toBe("claude-haiku-4-5");
      expect(eff?.apiKey).toBe("sk-ant-api03-real-key-1234abcd");
    });

    it("returns null when no row exists (caller falls back to env)", async () => {
      const prisma = makePrisma({});
      const svc = new PlatformLlmConfigService(prisma as any, makeEncryption(), {} as any);

      expect(await svc.resolveEffective()).toBeNull();
    });

    it("normalizes 'Anthropic' / 'ANTHROPIC' case-insensitively", async () => {
      const prisma = makePrisma({
        row: { ...REAL_ROW, provider: "ANTHROPIC" },
      });
      const svc = new PlatformLlmConfigService(prisma as any, makeEncryption(), {} as any);

      const eff = await svc.resolveEffective();
      expect(eff?.provider).toBe("anthropic");
    });

    it("a stored key that cannot be decrypted is an error, not a silent switch to the .env (P4)", async () => {
      const prisma = makePrisma({ row: { ...REAL_ROW, apiKeyEncrypted: "v2.from.another.key" } });
      const encryption = makeEncryption();
      encryption.decrypt.mockImplementation(() => {
        throw new Error("Unsupported state or unable to authenticate data");
      });
      const svc = new PlatformLlmConfigService(prisma as any, encryption, {} as any);
      (svc as any).logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
      await expect(svc.resolveEffective()).rejects.toBeInstanceOf(StoredLlmKeyUnreadableError);
      expect(await svc.getConfig()).toMatchObject({ hasKey: false, keyState: "unreadable", inUse: "unreadable" });
    });

    it("runs a stored MiniMax config on Anthropic, with a Claude model", async () => {
      // MiniMax was removed (audit D13): a row saved with it must not send
      // Claude requests to the gateway, nor a MiniMax model id to Anthropic.
      const prisma = makePrisma({
        row: { ...REAL_ROW, provider: "MiniMax", defaultModel: "MiniMax-M3", baseUrl: "https://gateway.example" },
      });
      const svc = new PlatformLlmConfigService(prisma as any, makeEncryption(), {} as any);

      const eff = await svc.resolveEffective();
      expect(eff).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5" });
      expect(eff).not.toHaveProperty("baseUrl");
    });

    it("runs a stored OpenAI / Google config, or an unknown model, on Anthropic's default (D9)", async () => {
      for (const row of [
        { ...REAL_ROW, provider: "openai", defaultModel: "gpt-4o" },
        { ...REAL_ROW, provider: "google", defaultModel: "gemini-pro" },
        { ...REAL_ROW, provider: "anthropic", defaultModel: "claude-2" },
      ]) {
        const svc = new PlatformLlmConfigService(makePrisma({ row }) as any, makeEncryption(), {} as any);
        expect(await svc.resolveEffective()).toMatchObject({ provider: "anthropic", model: "claude-haiku-5-5" });
      }
    });
  });

  describe("Anthropic only (D9)", () => {
    it("refuses another provider or a model outside CLAUDE_MODELS at save", async () => {
      const prisma = makePrisma({ row: REAL_ROW });
      const svc = new PlatformLlmConfigService(prisma as any, makeEncryption(), {} as any);
      await expect(svc.updateConfig({ provider: "openai" }, admin)).rejects.toThrow("solo funciona con Anthropic");
      await expect(svc.updateConfig({ defaultModel: "gpt-4o" }, admin)).rejects.toThrow("modelos de Claude");
      expect(prisma.platformLlmConfig.upsert).not.toHaveBeenCalled();
    });

    it("the DTOs accept only anthropic and the Claude models", () => {
      const errs = (cls: any, body: object) => validateSync(plainToInstance(cls, body)).map((e) => e.property);
      for (const cls of [UpdatePlatformLlmConfigDto, TestPlatformLlmConfigDto]) {
        expect(errs(cls, { provider: "anthropic", defaultModel: "claude-sonnet-5-5" })).toEqual([]);
        expect(errs(cls, { provider: "openai" })).toEqual(["provider"]);
        expect(errs(cls, { provider: "google" })).toEqual(["provider"]);
        expect(errs(cls, { defaultModel: "gpt-4o" })).toEqual(["defaultModel"]);
      }
    });

    it("does not test another provider or model", async () => {
      const svc = new PlatformLlmConfigService(makePrisma({ row: REAL_ROW }) as any, makeEncryption(), {} as any);
      await expect(svc.testConnection({ provider: "openai", apiKey: "k" })).resolves.toMatchObject({ ok: false });
      await expect(svc.testConnection({ defaultModel: "gpt-4o", apiKey: "k" })).resolves.toMatchObject({ ok: false });
    });
  });

  describe("testConnection sanitization", () => {
    it("never returns the plaintext apiKey in the error message", async () => {
      const prisma = makePrisma({});
      const svc = new PlatformLlmConfigService(prisma as any, makeEncryption(), {} as any);

      // testConnection returns ok=false when no key configured
      const original = process.env.ANTHROPIC_API_KEY;
      delete process.env.ANTHROPIC_API_KEY;
      const res = await new PlatformLlmConfigService(prisma as any, makeEncryption(), {} as any).testConnection();
      if (original !== undefined) process.env.ANTHROPIC_API_KEY = original;
      void svc;
      expect(res.ok).toBe(false);
      expect(res.message).not.toContain("sk-");
    });
  });
});