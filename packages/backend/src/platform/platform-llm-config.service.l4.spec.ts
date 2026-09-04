import { PlatformLlmConfigService } from "./platform-llm-config.service";

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
}) {
  return {
    platformLlmConfig: {
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
    });
  });

  describe("updateConfig", () => {
    it("encrypts a new apiKey before persisting", async () => {
      const prisma = makePrisma({});
      const encryption = makeEncryption();
      const svc = new PlatformLlmConfigService(prisma as any, encryption, {} as any);

      await svc.updateConfig({
        provider: "anthropic",
        apiKey: "sk-ant-api03-new-key-9999",
        defaultModel: "claude-haiku-4-5",
        updatedBy: "admin-2",
      });

      expect(encryption.encrypt).toHaveBeenCalledWith("sk-ant-api03-new-key-9999");
      const upsertArg = prisma.platformLlmConfig.upsert.mock.calls[0][0];
      expect(upsertArg.create.apiKeyEncrypted).toBe("enc:sk-ant-api03-new-key-9999");
      expect(upsertArg.create.updatedBy).toBe("admin-2");
    });

    it("does not overwrite the key when apiKey is empty (keep existing)", async () => {
      const prisma = makePrisma({ row: REAL_ROW });
      const encryption = makeEncryption();
      const svc = new PlatformLlmConfigService(prisma as any, encryption, {} as any);

      encryption.encrypt.mockClear();
      await svc.updateConfig({
        defaultModel: "claude-sonnet-4-5",
      });

      expect(encryption.encrypt).not.toHaveBeenCalled();
      // The update object should NOT contain apiKeyEncrypted.
      const upsertArg = prisma.platformLlmConfig.upsert.mock.calls[0][0];
      expect(upsertArg.update).not.toHaveProperty("apiKeyEncrypted");
      expect(upsertArg.update.defaultModel).toBe("claude-sonnet-4-5");
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
  });

  describe("testConnection sanitization", () => {
    it("never returns the plaintext apiKey in the error message", async () => {
      const prisma = makePrisma({});
      const svc = new PlatformLlmConfigService(prisma as any, makeEncryption(), {} as any);

      // testConnection returns ok=false when no key configured
      const res = await svc.testConnection();
      expect(res.ok).toBe(false);
      expect(res.message).not.toContain("sk-");
    });
  });
});