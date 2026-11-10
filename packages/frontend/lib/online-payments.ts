/**
 * The panel's "Cobros online" page: the salon's own Stripe account, connected
 * through KiraRoom, as the page shows it. Pure, so it is tested without the
 * browser (online-payments.spec.ts).
 */
import type { ConnectStatus } from "./api";

export type ConnectState = ConnectStatus["state"];

/** Translation key of the badge for a state. */
export function connectStateKey(state: ConnectState): string {
  return `onlinePayments.state_${state}`;
}

const STATE_CLASS: Record<ConnectState, string> = {
  none: "bg-gray-100 text-gray-800",
  pending: "bg-amber-100 text-amber-800",
  restricted: "bg-red-100 text-red-800",
  active: "bg-green-100 text-green-800",
};

export function connectStateClass(state: ConnectState): string {
  return STATE_CLASS[state] ?? STATE_CLASS.none;
}

/** What the main button does for a state. */
export type ConnectAction = "start" | "continue" | "fix" | "none";

export function connectAction(status: Pick<ConnectStatus, "state" | "platformReady">): ConnectAction {
  if (!status.platformReady) return "none";
  switch (status.state) {
    case "none":
      return "start";
    case "pending":
      return "continue";
    case "restricted":
      return "fix";
    default:
      return "none";
  }
}

/** Translation key of the main button for an action (null: no button). */
export function connectActionKey(action: ConnectAction): string | null {
  return action === "none" ? null : `onlinePayments.action_${action}`;
}

/**
 * What Stripe still asks for, in the salon's words: Stripe sends field paths
 * (`individual.id_number`, `external_account`...), grouped here into the few
 * things a salon understands. Each group once, in a stable order.
 */
const GROUPS: Array<{ key: string; test: (path: string) => boolean }> = [
  { key: "bank", test: (p) => p.startsWith("external_account") },
  { key: "identity", test: (p) => /^(individual|representative|person_|relationship)/.test(p) },
  { key: "company", test: (p) => /^(company|business_type)/.test(p) },
  { key: "business", test: (p) => p.startsWith("business_profile") },
  { key: "terms", test: (p) => p.startsWith("tos_acceptance") },
];

export function requirementGroups(paths: string[]): string[] {
  const found = new Set<string>();
  let other = false;
  for (const path of paths) {
    const group = GROUPS.find((g) => g.test(path));
    if (group) found.add(group.key);
    else other = true;
  }
  const ordered = GROUPS.map((g) => g.key).filter((k) => found.has(k));
  if (other) ordered.push("other");
  return ordered.map((k) => `onlinePayments.req_${k}`);
}

/** The page was opened by Stripe's redirect: back from the form, or the link expired. */
export function connectReturnKind(search: string): "return" | "refresh" | null {
  const value = new URLSearchParams(search).get("connect");
  return value === "return" || value === "refresh" ? value : null;
}

/** Only Stripe's own addresses may be opened as the sign-up form. */
export function safeConnectUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    return u.protocol === "https:" && (u.hostname === "stripe.com" || u.hostname.endsWith(".stripe.com")) ? url : null;
  } catch {
    return null;
  }
}
