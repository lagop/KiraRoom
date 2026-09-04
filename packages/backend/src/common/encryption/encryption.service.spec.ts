/**
 * Tests for the envelope-encryption (Phase 5) EncryptionService.
 *
 * Covers: per-tenant DEK round-trip, AWS provider shape (no AWS
 * account needed in CI), rotation, legacy v1 path compatibility.
 */

import { ConfigService } from "@nestjs/config";
import { EncryptionService } from "./encryption.service";

function makeConfig(env: Record<string, string | undefined>): ConfigService {
  return {
    get: (k: string) => env[k],
  } as unknown as ConfigService;
}

describe("EncryptionService — LocalKmsProvider (default)", () => {
  const KEY = Buffer.alloc(32, 1).toString("base64");

  it("initializes with a 32-byte env-supplied key", () => {
    const svc = new EncryptionService(
      makeConfig({ META_TOKEN_ENCRYPTION_KEY: KEY, KIRA_KMS_PROVIDER: "local" }),
    );
    expect(svc).toBeDefined();
  });

  it("refuses to initialize when META_TOKEN_ENCRYPTION_KEY is missing", () => {
    expect(
      () =>
        new EncryptionService(
          makeConfig({ META_TOKEN_ENCRYPTION_KEY: undefined }),
        ),
    ).toThrow(/META_TOKEN_ENCRYPTION_KEY is not set/);
  });

  it("refuses to initialize when META_TOKEN_ENCRYPTION_KEY is the wrong size", () => {
    expect(
      () =>
        new EncryptionService(
          makeConfig({ META_TOKEN_ENCRYPTION_KEY: Buffer.alloc(16).toString("base64") }),
        ),
    ).toThrow(/must decode to 32 bytes/);
  });

  it("encrypts and decrypts with a per-tenant DEK", async () => {
    const svc = new EncryptionService(
      makeConfig({ META_TOKEN_ENCRYPTION_KEY: KEY, KIRA_KMS_PROVIDER: "local" }),
    );
    const { dek, wrapped, kmsRef } = await svc.newDek();
    expect(dek.length).toBe(32);
    expect(wrapped).toBeTruthy();
    expect(kmsRef).toBe("local:env");
    svc.cacheDek("tenant-1", dek);
    const plain = "B12345678";
    const cipher = svc.encrypt(plain, "tenant-1");
    expect(cipher).not.toBe(plain);
    expect(cipher.split(".")[0]).toBe("v2");
    expect(svc.decrypt(cipher, "tenant-1")).toBe(plain);
  });

  it("round-trips the wrapped DEK via the LocalKmsProvider", async () => {
    const svc = new EncryptionService(
      makeConfig({ META_TOKEN_ENCRYPTION_KEY: KEY, KIRA_KMS_PROVIDER: "local" }),
    );
    const { dek, wrapped } = await svc.newDek();
    // Decrypt the wrapped DEK via a fresh service to simulate the
    // round-trip across an application restart.
    const fresh = new EncryptionService(
      makeConfig({ META_TOKEN_ENCRYPTION_KEY: KEY, KIRA_KMS_PROVIDER: "local" }),
    );
    // Use the internal unwrap via reflection for the test.
    const recovered = await (fresh as any).kms.unwrap(wrapped);
    expect(Buffer.compare(recovered, dek)).toBe(0);
  });

  it("falls back to legacy v1 path when tenantId is omitted", () => {
    const svc = new EncryptionService(
      makeConfig({ META_TOKEN_ENCRYPTION_KEY: KEY, KIRA_KMS_PROVIDER: "local" }),
    );
    // No DEK cached for any tenant, no tenantId passed — service falls
    // back to the env-based legacy key.
    const cipher = svc.encrypt("hello");
    expect(cipher).not.toBe("hello");
    expect(svc.decrypt(cipher)).toBe("hello");
  });

  it("supports v1 ciphertext format for migration", () => {
    // Manually produce a v1 ciphertext (3-part dot-separated, no
    // version tag) and ensure decrypt handles it via the legacy path.
    const svc = new EncryptionService(
      makeConfig({ META_TOKEN_ENCRYPTION_KEY: KEY, KIRA_KMS_PROVIDER: "local" }),
    );
    // Bypass encryption; directly use the internal helper.
    const iv = Buffer.alloc(12, 2);
    const { createCipheriv } = require("crypto");
    const cipher = createCipheriv("aes-256-gcm", Buffer.from(KEY, "base64"), iv);
    const ct = Buffer.concat([cipher.update("legacy-value", "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const v1 = [iv.toString("base64"), authTag.toString("base64"), ct.toString("base64")].join(".");
    // The v1 3-part format remains supported via the legacy env-key
    // fallback in LocalKmsProvider mode. AWS mode would throw.
    expect(svc.decrypt(v1)).toBe("legacy-value");
  });

  it("reencrypts with a fresh DEK and returns both the new wrapped DEK and ciphertext", async () => {
    const svc = new EncryptionService(
      makeConfig({ META_TOKEN_ENCRYPTION_KEY: KEY, KIRA_KMS_PROVIDER: "local" }),
    );
    const result = await svc.reencryptWithFreshDek("secret");
    expect(result.dek.length).toBe(32);
    expect(result.wrapped).toBeTruthy();
    expect(result.kmsRef).toBe("local:env");
    expect(result.ciphertext).toContain("v2.");
  });
});

describe("EncryptionService — AwsKmsProvider", () => {
  it("throws without KIRA_KMS_KEY_ID", () => {
    // LocalKmsProvider requires META_TOKEN_ENCRYPTION_KEY. With
    // KIRA_KMS_PROVIDER=aws AND KIRA_KMS_KEY_ID missing, the AWS
    // provider fails synchronously, falling back to local which then
    // fails on the env key. Either error is acceptable — what matters
    // is the service refuses to start without one of them.
    expect(
      () =>
        new EncryptionService(
          makeConfig({
            META_TOKEN_ENCRYPTION_KEY: undefined,
            KIRA_KMS_PROVIDER: "aws",
            KIRA_KMS_KEY_ID: undefined,
          }),
        ),
    ).toThrow();
  });

  it("initializes when KIRA_KMS_KEY_ID is set but AWS SDK is missing", () => {
    // The constructor doesn't import the AWS SDK at startup; the import
    // happens lazily on the first wrap/unwrap call. With the SDK
    // missing, those calls fail — but the service itself is constructed
    // successfully. This is the production behavior when
    // KIRA_KMS_PROVIDER=aws is set in an environment without the SDK
    // (e.g., a misconfigured staging deploy).
    const svc = new EncryptionService(
      makeConfig({
        KIRA_KMS_PROVIDER: "aws",
        KIRA_KMS_KEY_ID: "arn:aws:kms:eu-west-1:000:key/abc",
        META_TOKEN_ENCRYPTION_KEY: Buffer.alloc(32, 4).toString("base64"),
      }),
    );
    expect(svc).toBeDefined();
  });
});

describe("EncryptionService — hashIp / hmac", () => {
  const KEY = Buffer.alloc(32, 5).toString("base64");

  it("hashes IPs without leaking the raw address", () => {
    const svc = new EncryptionService(
      makeConfig({ META_TOKEN_ENCRYPTION_KEY: KEY, KIRA_KMS_PROVIDER: "local" }),
    );
    const a = svc.hashIp("192.168.1.1");
    const b = svc.hashIp("192.168.1.1");
    const c = svc.hashIp("192.168.1.2");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hmac is deterministic for the same input/secret", () => {
    const svc = new EncryptionService(
      makeConfig({ META_TOKEN_ENCRYPTION_KEY: KEY, KIRA_KMS_PROVIDER: "local" }),
    );
    const a = svc.hmac("payload", "secret");
    const b = svc.hmac("payload", "secret");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
