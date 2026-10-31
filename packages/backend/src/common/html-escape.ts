/**
 * Escapes a value for interpolation into HTML (text or a quoted attribute).
 *
 * Every value that reaches an email's HTML from data -- a client's name, a
 * service's name, the salon's name, a free-text reason -- goes through this:
 * names come from self-service sign-up and imports, and markup in them would
 * otherwise be rendered by the recipient's mail client. Plain-text parts of
 * an email and subjects are not HTML and are not escaped.
 */
export function escapeHtml(value: unknown): string {
  const s = value === null || value === undefined ? "" : String(value);
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
