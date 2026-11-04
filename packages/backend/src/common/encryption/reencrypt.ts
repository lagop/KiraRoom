/**
 * Re-encryption of every secret encrypted with META_TOKEN_ENCRYPTION_KEY,
 * from an old key to a new one (scripts/reencrypt-secrets.ts runs it).
 *
 * Despite its name, that variable is the ONE master key of EncryptionService:
 * it encrypts the platform console's Stripe, Resend and AI keys, the salons'
 * Stripe keys, WhatsApp/Meta/Telegram tokens, fiscal certificates, accounting
 * tokens and two-step secrets. Changing it without re-encrypting leaves all
 * of them unreadable: the console then marks Stripe, email and AI as
 * "sin configurar" (they never fall back to the .env in silence).
 *
 * The format is EncryptionService's: "v2.<iv>.<tag>.<ciphertext>" (or the
 * older three-part form), AES-256-GCM, base64 parts.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "crypto";

const ALGO = "aes-256-gcm";

/** Where encrypted values live: table, primary key, columns. */
export const ENCRYPTED_COLUMNS: Array<{ table: string; id: string; columns: string[] }> = [
  { table: "tenants", id: "id", columns: ["stripeTestSecretKey", "stripeLiveSecretKey"] },
  { table: "users", id: "id", columns: ["twoFactorSecret", "twoFactorPendingSecret"] },
  { table: "whatsapp_connections", id: "id", columns: ["accessTokenEnc", "refreshTokenEnc"] },
  { table: "fiscal_certificates", id: "id", columns: ["encryptedPem", "passphraseCipher"] },
  { table: "accounting_connections", id: "id", columns: ["encryptedAccessToken"] },
  { table: "platform_stripe_config", id: "id", columns: ["secretKeyEncrypted", "webhookSecretEncrypted", "otherWebhookSecretEncrypted"] },
  { table: "platform_email_config", id: "id", columns: ["apiKeyEncrypted", "webhookSecretEncrypted"] },
  { table: "PlatformLlmConfig", id: "id", columns: ["apiKeyEncrypted"] },
];

/** In tenants.features (the chat channels' tokens): every string under a key ending in "Enc". */
export const ENCRYPTED_JSON = { table: "tenants", id: "id", column: "features", keySuffix: "Enc" };

/** A META_TOKEN_ENCRYPTION_KEY value (base64 of 32 bytes) as a key. */
export function parseMasterKey(raw: string | undefined, name: string): Buffer {
  const buf = Buffer.from((raw ?? "").trim(), "base64");
  if (buf.length !== 32) throw new Error(`${name} must be base64 of 32 bytes (got ${buf.length} bytes).`);
  return buf;
}

export function decryptWith(packed: string, key: Buffer): string {
  const parts = packed.split(".");
  const [iv, tag, data] = parts.length === 4 && parts[0] === "v2" ? parts.slice(1) : parts.length === 3 ? parts : [];
  if (!iv || !tag || data === undefined) throw new Error("not an encrypted value");
  const decipher = createDecipheriv(ALGO, key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
}

export function encryptWith(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, key, iv);
  const data = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v2", iv.toString("base64"), cipher.getAuthTag().toString("base64"), data.toString("base64")].join(".");
}

export type ReencryptOutcome = "reencrypted" | "already-new" | "not-encrypted" | "unreadable";

const ENCRYPTED_SHAPE = /^(v2\.)?[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]*$/;

/**
 * One value: re-encrypted with the new key when the old one opens it;
 * left as is when the new key already opens it (the script can run again),
 * when it is not an encrypted value (a salon's Stripe key saved in clear
 * before encryption), or when neither key opens it (reported).
 */
export function reencryptValue(value: string, oldKey: Buffer, newKey: Buffer): { outcome: ReencryptOutcome; value: string } {
  if (!ENCRYPTED_SHAPE.test(value)) return { outcome: "not-encrypted", value };
  try {
    decryptWith(value, newKey);
    return { outcome: "already-new", value };
  } catch {
    // not the new key's
  }
  try {
    return { outcome: "reencrypted", value: encryptWith(decryptWith(value, oldKey), newKey) };
  } catch {
    return { outcome: "unreadable", value };
  }
}

/** The same, for every "…Enc" string inside a JSON value. Counts each outcome. */
export function reencryptJson(
  json: unknown,
  oldKey: Buffer,
  newKey: Buffer,
  suffix: string,
  counts: Record<ReencryptOutcome, number>,
): unknown {
  if (Array.isArray(json)) return json.map((v) => reencryptJson(v, oldKey, newKey, suffix, counts));
  if (!json || typeof json !== "object") return json;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
    if (typeof v === "string" && k.endsWith(suffix) && v) {
      const r = reencryptValue(v, oldKey, newKey);
      counts[r.outcome]++;
      out[k] = r.value;
    } else {
      out[k] = reencryptJson(v, oldKey, newKey, suffix, counts);
    }
  }
  return out;
}
