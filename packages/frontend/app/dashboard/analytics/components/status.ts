import type { Translate } from "../analytics-types";

/** Colours of the evolution charts' three statuses. */
export const STATUS_COLORS: Record<string, string> = {
  Completed: "#22c55e",
  Cancelled: "#ef4444",
  "No Show": "#6b7280",
};

/** The donuts show every status, not only the three of the evolution charts. */
export const DONUT_COLORS: Record<string, string> = {
  ...STATUS_COLORS,
  Confirmed: "#3b82f6",
  Pending: "#eab308",
  "In Progress": "#8b5cf6",
};

const STATUS_KEYS: Record<string, string> = {
  Completed: "analytics.completed",
  Cancelled: "analytics.cancelled",
  "No Show": "analytics.no_show",
  Confirmed: "analytics.status_confirmed",
  Pending: "analytics.status_pending",
  "In Progress": "analytics.status_in_progress",
};

/** The API's English status name, in the panel's language. */
export function statusLabel(t: Translate, status: string): string {
  const key = STATUS_KEYS[status];
  return key ? t(key) : status;
}
