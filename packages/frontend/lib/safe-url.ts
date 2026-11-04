/**
 * Links built from data someone else typed: a bug report's page address, a
 * salon's own privacy policy, a stored review or invoice link.
 *
 * React writes any string into `href` as it is, so a stored value with a
 * script scheme would run in the panel of whoever clicks it. Only absolute
 * http(s) URLs become links; anything else is shown as plain text.
 */

/** The value as a link target when it parses as an absolute http(s) URL; else null. */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}
