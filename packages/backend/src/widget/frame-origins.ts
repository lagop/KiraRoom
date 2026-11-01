/**
 * The sites a salon lets show its booking widget in an iframe. Each entry
 * is an https origin: scheme, host (optionally `*.` for its subdomains) and
 * port, nothing else. The list ends up in the embed page's
 * `Content-Security-Policy: frame-ancestors` header (frontend middleware),
 * so a `;`, a space or a path in an entry would add directives or widen it.
 */
export const WIDGET_ORIGIN_RE = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/i;

/** "https://MiSalon.com/ " -> "https://misalon.com": what people paste. */
export function normalizeWidgetOrigin(value: string): string {
  return value.trim().replace(/\/+$/, "").toLowerCase();
}

/**
 * The entries of a stored list that are valid origins, normalised and
 * de-duplicated. Rows saved before https was required (http:// entries, or
 * anything that slipped through) are dropped, never passed on.
 */
export function frameAncestorOrigins(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out = new Set<string>();
  for (const entry of list) {
    if (typeof entry !== "string") continue;
    const origin = normalizeWidgetOrigin(entry);
    if (origin.length <= 253 && WIDGET_ORIGIN_RE.test(origin)) out.add(origin);
  }
  return [...out];
}
