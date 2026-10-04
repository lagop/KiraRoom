import { createHmac } from "crypto";
import { signSvixPayload, verifySvixSignature } from "./svix-signature";

/**
 * Resend signs its webhooks with Svix. The webhook used to accept anything
 * (it was not even reachable, but its replacement must not be either), so
 * this pins the scheme against an independent computation of it and every
 * way a forged or replayed request can differ from a real one.
 */
describe("verifySvixSignature", () => {
  // Fictitious secret in Svix's format: "whsec_" + base64 key.
  const rawKey = Buffer.from("fictitious-signing-key-for-tests-0001");
  const secret = "whsec_" + rawKey.toString("base64");
  const body = JSON.stringify({ type: "email.opened", data: { email_id: "em_1" } });
  const id = "msg_2abc";
  const now = 1_790_000_000;
  const ts = String(now);

  /** The scheme from Svix's docs, written out independently of the code. */
  const reference = (payload: string) =>
    "v1," + createHmac("sha256", rawKey).update(`${id}.${ts}.${payload}`).digest("base64");

  it("accepts a correctly signed payload", () => {
    expect(signSvixPayload(body, id, ts, secret)).toBe(reference(body));
    expect(verifySvixSignature(Buffer.from(body), { id, timestamp: ts, signature: reference(body) }, secret, now)).toEqual({ ok: true });
  });

  it("accepts when any of several signatures matches (secret rotation)", () => {
    const signature = `v1,${Buffer.alloc(32).toString("base64")} ${reference(body)}`;
    expect(verifySvixSignature(body, { id, timestamp: ts, signature }, secret, now).ok).toBe(true);
  });

  it("rejects a body changed after signing", () => {
    const tampered = body.replace("email.opened", "email.complained");
    expect(verifySvixSignature(tampered, { id, timestamp: ts, signature: reference(body) }, secret, now)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("rejects a signature made with another secret", () => {
    const other = "whsec_" + Buffer.from("another-fictitious-key").toString("base64");
    const signature = signSvixPayload(body, id, ts, other);
    expect(verifySvixSignature(body, { id, timestamp: ts, signature }, secret, now).ok).toBe(false);
  });

  it("rejects a reused signature under a different svix-id", () => {
    expect(verifySvixSignature(body, { id: "msg_other", timestamp: ts, signature: reference(body) }, secret, now).ok).toBe(false);
  });

  it("rejects a replay outside the five-minute window", () => {
    expect(verifySvixSignature(body, { id, timestamp: ts, signature: reference(body) }, secret, now + 301)).toEqual({
      ok: false,
      reason: "stale_timestamp",
    });
    expect(verifySvixSignature(body, { id, timestamp: ts, signature: reference(body) }, secret, now + 299).ok).toBe(true);
  });

  it("rejects unsigned requests", () => {
    expect(verifySvixSignature(body, {}, secret, now)).toEqual({ ok: false, reason: "missing_headers" });
    expect(verifySvixSignature(body, { id, timestamp: ts }, secret, now)).toEqual({ ok: false, reason: "missing_headers" });
  });

  it("ignores signature versions it does not know", () => {
    const signature = reference(body).replace("v1,", "v2,");
    expect(verifySvixSignature(body, { id, timestamp: ts, signature }, secret, now).ok).toBe(false);
  });
});
