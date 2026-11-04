import { createHash } from "crypto";

/**
 * How the receptionist names whoever is writing in its logs.
 *
 * The id of a WhatsApp conversation is `whatsapp-<the sender's number>`, and
 * every message used to write it in full, several times ("Processing message
 * from client whatsapp-34…"). Logs have none of the erasure the database has,
 * and the number is not needed to follow a conversation: the channel prefix
 * and a short hash are enough to tell one sender's lines from another's.
 *
 * `whatsapp-34600111222` -> `whatsapp#5f1c09ab`; a client UUID -> `client#…`.
 */
export function logId(clientId: string | null | undefined): string {
  if (!clientId) return "anonymous";
  const value = String(clientId);
  const m = /^([a-z]+)-/i.exec(value);
  const kind = m ? m[1].toLowerCase() : "client";
  const hash = createHash("sha256").update(value).digest("hex").slice(0, 8);
  return `${kind}#${hash}`;
}
