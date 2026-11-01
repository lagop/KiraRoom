/**
 * How the wait list shows an entry's state. Kept pure so
 * lib/wait-list-status.spec.ts can check it without the page.
 *
 * Entries close in four ways: the client booked ("Ha reservado"), the salon
 * discarded it, the system expired it (its dates passed, or it sat untouched
 * for 90 days), or the client left from the "Ya no me interesa" link in a
 * notice. The last two say so, so the salon knows nobody on the team did it.
 */

export type WaitListStatus = "waiting" | "notified" | "cancelled" | "fulfilled" | "expired";

export const WAIT_LIST_STATUS_LABEL: Record<WaitListStatus, string> = {
  waiting: "Esperando",
  notified: "Avisado",
  fulfilled: "Ha reservado",
  cancelled: "Descartado",
  expired: "Caducado",
};

/** The filter tabs, in order. "open" is waiting + notified. */
export const WAIT_LIST_FILTERS: Array<[string, string]> = [
  ["open", "Pendientes"],
  ["fulfilled", "Han reservado"],
  ["cancelled", "Descartados"],
  ["expired", "Caducados"],
  ["all", "Todos"],
];

export function isOpenStatus(status: string): boolean {
  return status === "waiting" || status === "notified";
}

/** One line on why a closed entry closed, when the system or the client closed it. */
export function closedNote(entry: { status: string; closedReason?: string | null }): string | null {
  switch (entry.closedReason) {
    case "window_passed":
      return "Caducado: las fechas que pidió ya han pasado.";
    case "too_old":
      return "Caducado: llevaba 90 días sin avisos ni cambios.";
    case "client_left":
      return "Se quitó de la lista desde el enlace «Ya no me interesa» del aviso.";
    default:
      return entry.status === "expired" ? "Caducado." : null;
  }
}
