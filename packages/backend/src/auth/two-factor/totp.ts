import { createHash, createHmac, randomBytes } from "crypto";

/**
 * Time-based one-time passwords (RFC 6238, SHA-1, 6 digits, 30 s): the codes
 * Google Authenticator, Authy, 1Password and the like show. Implemented here,
 * a few lines on top of node:crypto, rather than adding a dependency for it;
 * totp.spec.ts checks it against the RFC's own test vectors.
 */

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error("Invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 20 random bytes (160 bits, the RFC's recommendation), base32. */
export function generateSecret(): string {
  return base32Encode(randomBytes(20));
}

export function stepAt(time: Date): number {
  return Math.floor(time.getTime() / 1000 / STEP_SECONDS);
}

/** The code for one 30 s step (HOTP of the step counter, RFC 4226). */
export function codeForStep(secretBase32: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = createHmac("sha1", base32Decode(secretBase32)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const binary = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return binary.toString().padStart(DIGITS, "0");
}

/**
 * The step a code matches, allowing one step either side for a phone clock
 * that is a little off, or null. A step at or before `lastStep` (one already
 * used) never matches, so a code seen over someone's shoulder cannot be
 * reused.
 */
export function verifyCode(
  secretBase32: string,
  code: string,
  now: Date,
  lastStep: number | null = null,
): number | null {
  const digits = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(digits)) return null;
  const current = stepAt(now);
  for (const step of [current, current - 1, current + 1]) {
    if (lastStep !== null && step <= lastStep) continue;
    if (codeForStep(secretBase32, step) === digits) return step;
  }
  return null;
}

/** What the authenticator app reads from the QR code. */
export function otpauthUrl(secretBase32: string, account: string, issuer = "KiraRoom"): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Ten single-use codes like "k7m2-9qxr", for when the phone is lost. */
export function generateRecoveryCodes(count = 10): string[] {
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789"; // no 0/o, 1/l/i
  return Array.from({ length: count }, () => {
    const bytes = randomBytes(8);
    const chars = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join("");
    return `${chars.slice(0, 4)}-${chars.slice(4)}`;
  });
}

/** How a recovery code is stored: hashed, normalised (case, spaces, dash). */
export function hashRecoveryCode(code: string): string {
  const normal = code.toLowerCase().replace(/[\s-]/g, "");
  return createHash("sha256").update(normal).digest("hex");
}
