/**
 * How the wait list shows an entry's state. Kept pure so
 * lib/wait-list-status.spec.ts can check it without the page. Everything
 * here is a messages key under "waitList" (es.json first, en.json to match);
 * the page translates it.
 *
 * Entries close in four ways: the client booked ("Ha reservado"), the salon
 * discarded it, the system expired it (its dates passed, or it sat untouched
 * for 90 days), or the client left from the "Ya no me interesa" link in a
 * notice. The last two say so, so the salon knows nobody on the team did it.
 */

export type WaitListStatus = "waiting" | "notified" | "cancelled" | "fulfilled" | "expired";

export const WAIT_LIST_STATUS_KEY: Record<WaitListStatus, string> = {
  waiting: "waitList.status.waiting",
  notified: "waitList.status.notified",
  fulfilled: "waitList.status.fulfilled",
  cancelled: "waitList.status.cancelled",
  expired: "waitList.status.expired",
};

/** The filter tabs, in order: [filter, label key]. "open" is waiting + notified. */
export const WAIT_LIST_FILTERS: Array<[string, string]> = [
  ["open", "waitList.filters.open"],
  ["fulfilled", "waitList.filters.fulfilled"],
  ["cancelled", "waitList.filters.cancelled"],
  ["expired", "waitList.filters.expired"],
  ["all", "waitList.filters.all"],
];

export function isOpenStatus(status: string): boolean {
  return status === "waiting" || status === "notified";
}

/** The key of one line on why a closed entry closed, when the system or the client closed it. */
export function closedNote(entry: { status: string; closedReason?: string | null }): string | null {
  switch (entry.closedReason) {
    case "window_passed":
      return "waitList.closed.window_passed";
    case "too_old":
      return "waitList.closed.too_old";
    case "client_left":
      return "waitList.closed.client_left";
    default:
      return entry.status === "expired" ? "waitList.closed.expired" : null;
  }
}
