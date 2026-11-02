/**
 * Editing an existing booking widget (allowed sites, services and
 * professionals) through PATCH /widget/instances/:id. The page could only
 * create and revoke, so fixing a typo in an allowed site meant revoking the
 * widget and pasting new code into the salon's website.
 */
import type { WidgetInstance } from "./api";

export interface WidgetDraft {
  allowedOriginsText: string;
  /** Empty: every bookable service / every active professional. */
  services: string[];
  professionals: string[];
}

/** One site per line, blank lines dropped. The server normalises and checks them. */
export function parseOrigins(text: string): string[] {
  return text
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
}

export function draftFrom(w: Pick<WidgetInstance, "allowedOrigins" | "services" | "professionals">): WidgetDraft {
  return {
    allowedOriginsText: (w.allowedOrigins ?? []).join("\n"),
    services: [...(w.services ?? [])],
    professionals: [...(w.professionals ?? [])],
  };
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
): { allowedOrigins: string[]; services: string[]; professionals: string[] } {
  const keep = (ids: string[], items: ReadonlyArray<{ id: string }>) => {
    const valid = new Set(items.map((i) => i.id));
    return ids.filter((id) => valid.has(id));
  };
  return {
    allowedOrigins: parseOrigins(draft.allowedOriginsText),
    services: keep(draft.services, known.services),
    professionals: keep(draft.professionals, known.professionals),
  };
}
