import { createHmac, timingSafeEqual } from "crypto";

/**
 * Verification of webhooks signed with Svix, which is what Resend uses.
 *
 * Scheme (docs.svix.com/receiving/verifying-payloads/how-manual):
 *   signed content = `${svix-id}.${svix-timestamp}.${raw body}`
 *   key            = base64-decode(secret without its "whsec_" prefix)
 *   signature      = base64(HMAC-SHA256(key, signed content))
 * The `svix-signature` header carries one or more space-separated
 * `v1,<signature>` entries (several while a secret is being rotated); any
 * one matching is enough.
 *
 * Done with node:crypto rather than the `svix` package because the scheme
 * is a dozen lines and the package is not otherwise a dependency.
 */

/** Same window the official Svix library uses. */
export const SVIX_TOLERANCE_SECONDS = 5 * 60;

export interface SvixHeaders {
  id?: string;
  timestamp?: string;
  signature?: string;
}

/** `reason` is set when `ok` is false. (Flat, not a union: the backend
 * compiles without strictNullChecks, where a union on `ok` does not narrow.) */
export interface SvixVerification {
  ok: boolean;
  reason?: "missing_headers" | "stale_timestamp" | "bad_signature" | "bad_secret";
}

export function verifySvixSignature(
  payload: Buffer | string,
  headers: SvixHeaders,
  secret: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): SvixVerification {
  const { id, timestamp, signature } = headers;
  if (!id || !timestamp || !signature) return { ok: false, reason: "missing_headers" };

  // The timestamp is part of the signed content, so checking it bounds how
  // long a captured request can be replayed.
  const sentAt = Number(timestamp);
  if (!Number.isInteger(sentAt) || Math.abs(nowSeconds - sentAt) > SVIX_TOLERANCE_SECONDS) {
    return { ok: false, reason: "stale_timestamp" };
  }

  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret, "base64");
  if (key.length === 0) return { ok: false, reason: "bad_secret" };

  const body = typeof payload === "string" ? payload : payload.toString("utf8");
  const expected = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest();

  for (const entry of signature.split(" ")) {
    const [version, value] = entry.split(",", 2);
    if (version !== "v1" || !value) continue;
    const given = Buffer.from(value, "base64");
    if (given.length === expected.length && timingSafeEqual(given, expected)) return { ok: true };
  }
  return { ok: false, reason: "bad_signature" };
}

/** Signs like Svix does. Exported for tests, which play the part of Resend. */
export function signSvixPayload(payload: string, id: string, timestamp: string, secret: string): string {
  const key = Buffer.from(secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret, "base64");
  return "v1," + createHmac("sha256", key).update(`${id}.${timestamp}.${payload}`).digest("base64");
}
