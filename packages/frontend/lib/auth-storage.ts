/**
 * Where this tab keeps its session (access token and signed-in user).
 *
 * Audit 8, C10: the platform owner enters a salon as support in a NEW tab.
 * That tab keeps its session in sessionStorage (this tab only), so the
 * console's session in localStorage -- and in every other console tab -- stays
 * as it was. Before, entering a salon overwrote the console's token in this
 * browser: other console tabs started talking to the API as the salon owner,
 * and leaving meant signing in to the console again.
 *
 * The backend keeps the two apart as well: a support session has its own
 * refresh cookie per salon (kr_support_<tenantId>), not kr_session.
 */

/** sessionStorage key: the salon this tab is inside as support. */
export const SUPPORT_TAB_KEY = "kr_support_tab";

export interface SupportTab {
  tenantId: string;
  tenantName: string;
  /** ISO time the session ends at (the backend's 2-hour cap). */
  endsAt?: string;
}

function session(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

/** The support session this tab is in, or null for a normal tab. */
export function supportTab(): SupportTab | null {
  const raw = session()?.getItem(SUPPORT_TAB_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as SupportTab;
    return parsed && typeof parsed.tenantId === "string" ? parsed : null;
  } catch {
    return null;
  }
}

/** Marks this tab as a support session (the /login entry from the console). */
export function startSupportTab(tab: SupportTab): void {
  session()?.setItem(SUPPORT_TAB_KEY, JSON.stringify(tab));
}

export function updateSupportTab(patch: Partial<SupportTab>): void {
  const current = supportTab();
  if (current) startSupportTab({ ...current, ...patch });
}

/** Ends the support tab: its token and user go, and the tab reads the console's again. */
export function endSupportTab(): void {
  const s = session();
  if (!s) return;
  s.removeItem("kira_auth_token");
  s.removeItem("kira_refresh_token");
  s.removeItem("user");
  s.removeItem(SUPPORT_TAB_KEY);
}

/**
 * The storage that holds this tab's session: sessionStorage in a support tab,
 * localStorage otherwise. Every read or write of the token or the user goes
 * through here.
 */
export function authStorage(): Storage {
  if (supportTab()) return window.sessionStorage;
  return window.localStorage;
}
