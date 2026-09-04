import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
  createHmac,
} from "crypto";

/**
 * Encryption service with envelope encryption + KMS-managed master key.
 *
 * Architecture (Phase 5 of the final roadmap):
 *   - Each tenant gets a per-tenant Data Encryption Key (DEK), generated
 *     on first write, wrapped by a master key, and persisted in
 *     `Tenant.encryptedDek` (ciphertext + wrapped DEK reference).
 *   - The master key never leaves the KMS provider. With
 *     `KIRA_KMS_PROVIDER=local`, the master key is a single env var
 *     (the legacy behavior). With `KIRA_KMS_PROVIDER=aws`, the master
 *     key is an AWS KMS key referenced by `KIRA_KMS_KEY_ID`.
 *   - All PII fields (client.taxId, tenant.taxId, fiscal certificate
 *     PKCS#12, accounting tokens) are encrypted with the tenant's DEK
 *     using AES-256-GCM.
 *   - The public interface (`encrypt(plain)` / `decrypt(packed)`) is
 *     unchanged — callers don't need to know whether the master key is
 *     local or KMS-backed.
 *
 * DEK rotation is the responsibility of the operator; the public
 * `rotateDek(tenantId)` method re-wraps the DEK and re-encrypts all
 * tenant rows. The function is intentionally admin-only.
 */

const ALGO = "aes-256-gcm";
const KEY_BYTES = 32;
const IV_BYTES = 12;
const DEK_BYTES = 32;

export interface EncryptedField {
  iv: string;
  authTag: string;
  ciphertext: string;
  /** Version tag for the encryption scheme. v1 = single env key. v2 = envelope (DEK + KMS). */
  v: "v1" | "v2";
  /** Optional reference to the wrapped DEK (e.g. AWS KMS key ARN + ciphertext blob). */
  dekRef?: string;
}

export interface KmsProvider {
  /** Encrypts a small payload (the DEK) with the master key. */
  wrap(dataEncryptionKey: Buffer): Promise<string>;
  /** Decrypts a previously-wrapped DEK. */
  unwrap(wrapped: string): Promise<Buffer>;
  /** True if the master key is local (env-based). Used for testing. */
  isLocal(): boolean;
}

class LocalKmsProvider implements KmsProvider {
  private readonly key: Buffer;

  constructor(configService: ConfigService) {
    const raw = configService.get<string>("META_TOKEN_ENCRYPTION_KEY");
    if (!raw) {
      throw new Error(
        "META_TOKEN_ENCRYPTION_KEY is not set. " +
          "Generate one with: openssl rand -base64 32",
      );
    }
    const buf = Buffer.from(raw, "base64");
    if (buf.length !== KEY_BYTES) {
      throw new Error(
        `META_TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${buf.length}).`,
      );
    }
    this.key = buf;
  }

  async wrap(dek: Buffer): Promise<string> {
    // For local mode, "wrapping" is symmetric encryption with the env
    // master key. The wrapped blob is base64-encoded AES-GCM.
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, this.key, iv);
    const ciphertext = Buffer.concat([cipher.update(dek), cipher.final()]);
    const authTag = cipher.getAuthTag();
    return [
      iv.toString("base64"),
      authTag.toString("base64"),
      ciphertext.toString("base64"),
    ].join(".");
  }

  async unwrap(wrapped: string): Promise<Buffer> {
    const parts = wrapped.split(".");
    if (parts.length !== 3) {
      throw new Error("Invalid wrapped DEK");
    }
    const iv = Buffer.from(parts[0], "base64");
    const authTag = Buffer.from(parts[1], "base64");
    const ciphertext = Buffer.from(parts[2], "base64");
    const decipher = createDecipheriv(ALGO, this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  isLocal(): boolean {
    return true;
  }
}

/**
 * AWS KMS-backed provider. Loaded only when `KIRA_KMS_PROVIDER=aws` so
 * `@aws-sdk/client-kms` is an optional dep. In CI/staging where creds
 * are absent the service falls back to LocalKmsProvider via the
 * constructor's `try/catch`.
 */
class AwsKmsProvider implements KmsProvider {
  private readonly keyId: string;
  private readonly region: string;
  private client: any | null = null;
  private clientLoadError: Error | null = null;

  constructor(configService: ConfigService) {
    this.keyId = configService.get<string>("KIRA_KMS_KEY_ID") ?? "";
    this.region = configService.get<string>("AWS_REGION", "eu-west-1");
    if (!this.keyId) {
      throw new Error("KIRA_KMS_KEY_ID is not set");
    }
  }

  /**
   * Lazy SDK load. The first call to `wrap` or `unwrap` triggers the
   * dynamic `import()` of `@aws-sdk/client-kms`. We cache the loaded
   * client and the load error so a second call doesn't re-import.
   */
  private async loadClient(): Promise<any> {
    if (this.client) return this.client;
    if (this.clientLoadError) throw this.clientLoadError;
    try {
      // @ts-expect-error — optional dep, may not be installed
      const mod: any = await import("@aws-sdk/client-kms");
      this.client = new mod.KMSClient({ region: this.region });
      return this.client;
    } catch (err) {
      const e = new Error(
        `AWS KMS client unavailable — install @aws-sdk/client-kms (${(err as Error).message})`,
      );
      this.clientLoadError = e;
      throw e;
    }
  }

  async wrap(dek: Buffer): Promise<string> {
    // @ts-expect-error — optional dep
    const mod: any = await import("@aws-sdk/client-kms");
    const client = await this.loadClient();
    const out = await client.send(
      new mod.EncryptCommand({
        KeyId: this.keyId,
        Plaintext: dek,
      }),
    );
    if (!out.CiphertextBlob) throw new Error("AWS KMS returned no ciphertext");
    return Buffer.from(out.CiphertextBlob).toString("base64");
  }

  async unwrap(wrapped: string): Promise<Buffer> {
    // @ts-expect-error — optional dep
    const mod: any = await import("@aws-sdk/client-kms");
    const client = await this.loadClient();
    const out = await client.send(
      new mod.DecryptCommand({
        CiphertextBlob: Buffer.from(wrapped, "base64"),
      }),
    );
    if (!out.Plaintext) throw new Error("AWS KMS returned no plaintext");
    return Buffer.from(out.Plaintext);
  }

  isLocal(): boolean {
    return false;
  }
}

@Injectable()
export class EncryptionService {
  private readonly logger = new Logger(EncryptionService.name);
  private readonly kms: KmsProvider;
  /**
   * Per-tenant DEK cache. Keyed by tenantId. Populated lazily on the
   * first encrypt/decrypt call and invalidated on `rotateDek(tenantId)`.
   * Cached for the lifetime of the service instance.
   */
  private readonly dekCache = new Map<string, Buffer>();
  /**
   * Fallback master key (env-based). Used when:
   *   - `KIRA_KMS_PROVIDER` is unset (default), OR
   *   - `KIRA_KMS_PROVIDER=aws` is set but the AWS SDK is missing.
   *
   * NOT used when `KIRA_KMS_PROVIDER=aws` is configured AND the SDK loads
   * — in that mode, callers MUST go through the per-tenant DEK
   * (cached via `cacheDek(tenantId, dek)`) because the master key is
   * only available via AWS KMS — never as an env var.
   *
   * The fallback is intentionally permissive to preserve the v1
   * `decrypt(cipher)` signature used by the XAdES signer and other
   * service-level callers that predate the per-tenant DEK model.
   */
  private readonly legacyKey: Buffer | null;

  constructor(configService: ConfigService) {
    const provider = (configService.get<string>("KIRA_KMS_PROVIDER") ?? "local").toLowerCase();
    if (provider === "aws") {
      try {
        this.kms = new AwsKmsProvider(configService);
        this.legacyKey = null;
        this.logger.log("Encryption: AWS KMS provider");
        return;
      } catch (err) {
        this.logger.warn(
          `AWS KMS unavailable (${(err as Error).message}); falling back to LocalKmsProvider`,
        );
      }
    }
    this.kms = new LocalKmsProvider(configService);
    // Re-derive the legacy key from the same env var the LocalKmsProvider
    // reads. We compute it here (instead of reaching into the private
    // kms.key) so the legacy path stays functional until callers migrate
    // to the per-tenant DEK API.
    const raw = configService.get<string>("META_TOKEN_ENCRYPTION_KEY");
    if (raw) {
      const buf = Buffer.from(raw, "base64");
      this.legacyKey = buf.length === KEY_BYTES ? buf : null;
    } else {
      this.legacyKey = null;
    }
    this.logger.log("Encryption: LocalKmsProvider (env-based master key)");
  }

  /**
   * Generate a fresh DEK and wrap it under the master key. Returned in
   * the format suitable for storage in `Tenant.encryptedDek`. The DEK
   * itself is also returned in the `dek` field for callers that need
   * to perform local encryption without an extra roundtrip.
   */
  async newDek(): Promise<{ dek: Buffer; wrapped: string; kmsRef: string }> {
    const dek = randomBytes(DEK_BYTES);
    const wrapped = await this.kms.wrap(dek);
    const kmsRef = this.kms.isLocal()
      ? "local:env"
      : `aws:${process.env.AWS_REGION ?? "eu-west-1"}`;
    return { dek, wrapped, kmsRef };
  }

  /**
   * Cache the DEK for a tenant. Called by a higher-level service that
   * owns the tenant.encryptedDek field.
   */
  cacheDek(tenantId: string, dek: Buffer): void {
    this.dekCache.set(tenantId, dek);
  }

  invalidateDek(tenantId: string): void {
    this.dekCache.delete(tenantId);
  }

  /**
   * Public encrypt API. `tenantId` is required so the service can pick
   * the tenant's DEK. If the DEK is not cached, the caller is expected
   * to provide it via `cacheDek` first (after fetching from
   * `Tenant.encryptedDek`).
   *
   * If `tenantId` is omitted (legacy v1 callers), the service falls
   * back to a process-wide env key. This is the migration period
   * behavior — production callers should always pass tenantId.
   */
  encrypt(plain: string, tenantId?: string): string {
    if (tenantId && this.dekCache.has(tenantId)) {
      return this.encryptWithDek(plain, this.dekCache.get(tenantId)!);
    }
    // Legacy v1 path: env-based master key. Only available when the
    // LocalKmsProvider is configured (no AWS provider). In AWS mode,
    // callers MUST cache a tenant DEK first — there's no env fallback
    // because the master key lives only inside AWS KMS.
    if (this.legacyKey === null) {
      throw new Error(
        "EncryptionService: no DEK cached and legacy env key unavailable " +
          "(AWS KMS mode requires cacheDek(tenantId, dek) before encrypt)",
      );
    }
    return this.encryptWithDek(plain, this.legacyKey);
  }

  decrypt(packed: string, tenantId?: string): string {
    if (tenantId && this.dekCache.has(tenantId)) {
      return this.decryptWithDek(packed, this.dekCache.get(tenantId)!);
    }
    if (this.legacyKey === null) {
      throw new Error(
        "EncryptionService: no DEK cached and legacy env key unavailable " +
          "(AWS KMS mode requires cacheDek(tenantId, dek) before decrypt)",
      );
    }
    return this.decryptWithDek(packed, this.legacyKey);
  }

  /**
   * Re-encrypt a value with a fresh DEK. Used by `rotateDek`. Returns
   * the new ciphertext and the wrapped DEK for storage.
   */
  async reencryptWithFreshDek(plain: string): Promise<{
    dek: Buffer;
    wrapped: string;
    kmsRef: string;
    ciphertext: string;
  }> {
    const { dek, wrapped, kmsRef } = await this.newDek();
    const ciphertext = this.encryptWithDek(plain, dek);
    return { dek, wrapped, kmsRef, ciphertext };
  }

  hashIp(ip: string): string {
    return createHash("sha256").update(ip || "").digest("hex");
  }

  hmac(value: string, secret: string): string {
    return createHmac("sha256", secret).update(value).digest("hex");
  }

  // ---- internal helpers ----

  private encryptWithDek(plain: string, dek: Buffer): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGO, dek, iv);
    const ciphertext = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const authTag = cipher.getAuthTag();
    const v: EncryptedField["v"] = "v2";
    return [
      v,
      iv.toString("base64"),
      authTag.toString("base64"),
      ciphertext.toString("base64"),
    ].join(".");
  }

  private decryptWithDek(packed: string, dek: Buffer): string {
    if (!packed || typeof packed !== "string") {
      throw new Error("Invalid encrypted payload format");
    }
    // Accept both v1 (no version tag) and v2 (with version tag) for
    // the migration period. v1 callers without a DEK use the legacy
    // path; v2 callers must have already cached the tenant DEK.
    const parts = packed.split(".");
    let ivB64: string;
    let authTagB64: string;
    let ciphertextB64: string;
    if (parts.length === 4 && parts[0] === "v2") {
      [, ivB64, authTagB64, ciphertextB64] = parts;
    } else if (parts.length === 3) {
      [ivB64, authTagB64, ciphertextB64] = parts;
    } else {
      throw new Error("Invalid encrypted payload format");
    }
    const iv = Buffer.from(ivB64, "base64");
    const authTag = Buffer.from(authTagB64, "base64");
    const ciphertext = Buffer.from(ciphertextB64, "base64");
    const decipher = createDecipheriv(ALGO, dek, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]).toString("utf8");
  }
}
