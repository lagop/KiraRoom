import { createHmac, randomUUID, timingSafeEqual } from "crypto";

/**
 * The identity of a visitor who chats on a salon's site without signing in.
 *
 * The browser used to choose it: it sent a `clientId` and the receptionist
 * picked up whatever conversation had that id. A visitor's own id was a random
 * UUID, hard to guess, but nothing stopped a caller from sending a signed-in
 * client's id (they appear in URLs) and continuing that client's conversation,
 * whose history can hold the name, phone and email they gave.
 *
 * Now the server issues the id, signed: `v1.<salonId>.<visitorUuid>.<mac>`.
 * The browser keeps it and sends it back; a token that was not issued by us,
 * or was issued for another salon, is ignored and the visitor starts afresh.
 * The key is derived from JWT_SECRET, so no new secret has to be set.
 */
const VERSION = "v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The id conversations are stored under (ChatConversation.context.visitorKey). */
export function visitorKey(visitorUuid: string): string {
  return `visitor-${visitorUuid}`;
}

function mac(secret: string, salonId: string, visitorUuid: string): string {
  const key = createHmac("sha256", secret).update("chat-visitor-token").digest();
  return createHmac("sha256", key).update(`${VERSION}.${salonId}.${visitorUuid}`).digest("base64url");
}

export function issueVisitorToken(secret: string, salonId: string, visitorUuid: string = randomUUID()): string {
  return `${VERSION}.${salonId}.${visitorUuid}.${mac(secret, salonId, visitorUuid)}`;
}

/** The visitor's UUID if the token is ours and for this salon; otherwise null. */
export function readVisitorToken(secret: string, salonId: string, token: unknown): string | null {
  if (typeof token !== "string" || token.length > 200) return null;
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [version, tokenSalon, visitorUuid, given] = parts;
  if (version !== VERSION || tokenSalon !== salonId || !UUID.test(visitorUuid)) return null;
  const expected = Buffer.from(mac(secret, salonId, visitorUuid));
  const actual = Buffer.from(given);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return visitorUuid;
}

/**
 * The id a browser chose before tokens existed (`visitor-<uuid>`, random and
 * kept in its localStorage). Accepted once so an ongoing chat survives the
 * deploy; it is then signed. A client's own id never qualifies.
 */
export function legacyVisitorUuid(clientId: unknown): string | null {
  if (typeof clientId !== "string") return null;
  const m = /^visitor-([0-9a-f-]{36})$/i.exec(clientId);
  return m && UUID.test(m[1]) ? m[1].toLowerCase() : null;
}
