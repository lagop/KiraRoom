/**
 * Editing an existing booking widget (allowed sites, services and
 * professionals) through PATCH /widget/instances/:id. The page could only
 * create and revoke, so fixing a typo in an allowed site meant revoking the
 * widget and pasting new code into the salon's website.
 */
import type { WebDomainStatus, WidgetInstance } from "./api";
import { validHexColor } from "./embed-theme";

export interface WidgetDraft {
  allowedOriginsText: string;
  /** Empty: every bookable service / every active professional. */
  services: string[];
  professionals: string[];
  /**
   * The widget's main colour ("#7c3aed"), "" for the default purple. Left
   * out (older callers): the theme is not sent.
   */
  primaryColor?: string;
}

/** One site per line, blank lines dropped. The server normalises and checks them. */
export function parseOrigins(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function draftFrom(
  w: Pick<WidgetInstance, "allowedOrigins" | "services" | "professionals"> & Partial<Pick<WidgetInstance, "theme">>,
): WidgetDraft {
  return {
    allowedOriginsText: (w.allowedOrigins ?? []).join("\n"),
    services: [...(w.services ?? [])],
    professionals: [...(w.professionals ?? [])],
    primaryColor: validHexColor(w.theme?.primaryColor) ?? "",
  };
}

/**
 * The sites a new widget is offered to allow: the salon's own website (as
 * an https origin) and its domain or subdomain once live. Only a start: the
 * salon can edit the list before creating it.
 */
export function suggestedOrigins(
  website: string | null | undefined,
  webDomain: Pick<WebDomainStatus, "domain" | "subdomain"> | null | undefined,
): string[] {
  const out: string[] = [];
  const add = (o: string | null) => {
    if (o && !out.includes(o)) out.push(o);
  };
  if (website) {
    try {
      const url = new URL(website.trim());
      if (url.protocol === "https:" || url.protocol === "http:") add(`https://${url.host.toLowerCase()}`);
    } catch {
      // Not a URL: nothing to offer.
    }
  }
  if (webDomain?.domain?.active && webDomain.domain.name) add(`https://${webDomain.domain.name.toLowerCase()}`);
  if (webDomain?.subdomain?.active && webDomain.subdomain.host) add(`https://${webDomain.subdomain.host.toLowerCase()}`);
  return out;
}

/** Adds or removes one id from a selection. */
export function toggleId(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

/**
 * The PATCH body. Ids no longer in the salon's lists (a service deleted
 * since) are dropped, so an all-gone selection does not hide everything.
 */
export function widgetUpdateFrom(
  draft: WidgetDraft,
  known: { services: ReadonlyArray<{ id: string }>; professionals: ReadonlyArray<{ id: string }> },
): {
  allowedOrigins: string[];
  services: string[];
  professionals: string[];
  theme?: { primaryColor: string | null };
} {
  const keep = (ids: string[], items: ReadonlyArray<{ id: string }>) => {
    const valid = new Set(items.map((i) => i.id));
    return ids.filter((id) => valid.has(id));
  };
  return {
    allowedOrigins: parseOrigins(draft.allowedOriginsText),
    services: keep(draft.services, known.services),
    professionals: keep(draft.professionals, known.professionals),
    ...(draft.primaryColor !== undefined ? { theme: { primaryColor: validHexColor(draft.primaryColor) } } : {}),
  };
}
