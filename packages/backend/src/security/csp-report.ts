/**
 * What a browser sends when a page breaks its Content Security Policy, in
 * either format: the older `{"csp-report": {...}}` (report-uri; Firefox,
 * Safari) or the Reporting API's `[{type: "csp-violation", body: {...}}]`
 * (report-to; Chromium).
 *
 * Only the parts that say what to fix are kept, and URLs lose their query
 * string and fragment: a page address can carry a booking or reset token.
 */
export interface CspViolation {
  directive: string;
  blocked: string;
  page: string;
  source?: string;
  disposition?: string;
}

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

/** Origin plus path, without query or fragment; keywords like "inline" pass through. */
export function cleanUrl(value: unknown): string {
  const s = str(value);
  if (!s) return "";
  try {
    const u = new URL(s);
    return `${u.origin}${u.pathname}`.slice(0, 300);
  } catch {
    return s.split(/[?#]/)[0].slice(0, 100);
  }
}

function fromLegacy(r: Record<string, unknown>): CspViolation | null {
  const directive = str(r["effective-directive"]) ?? str(r["violated-directive"]);
  if (!directive) return null;
  const file = str(r["source-file"]);
  const line = r["line-number"];
  return {
    directive: directive.split(" ")[0],
    blocked: cleanUrl(r["blocked-uri"]),
    page: cleanUrl(r["document-uri"]),
    source: file ? `${cleanUrl(file)}${typeof line === "number" ? `:${line}` : ""}` : undefined,
    disposition: str(r["disposition"]),
  };
}

function fromReportingApi(b: Record<string, unknown>): CspViolation | null {
  const directive = str(b["effectiveDirective"]);
  if (!directive) return null;
  const file = str(b["sourceFile"]);
  const line = b["lineNumber"];
  return {
    directive,
    blocked: cleanUrl(b["blockedURL"]),
    page: cleanUrl(b["documentURL"]),
    source: file ? `${cleanUrl(file)}${typeof line === "number" ? `:${line}` : ""}` : undefined,
    disposition: str(b["disposition"]),
  };
}

export function parseCspReport(body: unknown): CspViolation[] {
  if (Array.isArray(body)) {
    return body
      .slice(0, 20)
      .filter((r) => r && typeof r === "object" && (r as any).type === "csp-violation" && (r as any).body)
      .map((r) => fromReportingApi((r as any).body))
      .filter((v): v is CspViolation => v !== null);
  }
  if (body && typeof body === "object" && (body as any)["csp-report"]) {
    const v = fromLegacy((body as any)["csp-report"]);
    return v ? [v] : [];
  }
  return [];
}
