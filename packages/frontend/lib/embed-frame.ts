/**
 * The booking widget's page (/embed/<token>) says which sites may show it
 * in an iframe: `Content-Security-Policy: frame-ancestors`, from the
 * widget's allowed origins (middleware.ts, asking the API). Pure, tested in
 * embed-frame.spec.ts.
 */

/** Widget tokens: base64url, as the backend makes them. */
export const EMBED_PATH_RE = /^\/embed\/([A-Za-z0-9_-]{16,128})\/?$/;

/** An https origin, optionally `*.` for subdomains, and nothing that could add a directive. */
const ORIGIN_RE = /^https:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)+(:\d{1,5})?$/;

export function embedToken(pathname: string): string | null {
  return EMBED_PATH_RE.exec(pathname)?.[1] ?? null;
}

/**
 * The header value for an API answer, or null for "send none" (any site may
 * frame it: the salon left the list empty, or the API did not answer). A
 * list with entries but none valid allows only the app itself. Each entry is
 * re-checked here, so a `;`, a space, a quote or a newline from the API can
 * never reach the header.
 */
export function frameAncestorsHeader(answer: unknown): string | null {
  if (!answer || typeof answer !== "object") return null;
  const { allowedOrigins, restricted } = answer as { allowedOrigins?: unknown; restricted?: unknown };
  const origins = Array.isArray(allowedOrigins)
    ? [
        ...new Set(
          allowedOrigins
            .filter((o): o is string => typeof o === "string")
            .map((o) => o.trim().toLowerCase())
            .filter((o) => o.length <= 253 && ORIGIN_RE.test(o)),
        ),
      ]
    : [];
  if (origins.length > 0) return `frame-ancestors 'self' ${origins.join(" ")}`;
  return restricted === true ? "frame-ancestors 'self'" : null;
}
