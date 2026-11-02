/**
 * Ajustes > Contabilidad: the export's default dates in the salon's day, and
 * the Holded log in Spanish.
 *
 * The defaults were worked out in UTC, so just after midnight in Madrid on
 * the 1st of a quarter the export still offered the previous quarter, and
 * "hasta" was yesterday. The log printed sync / cancel / ok / error as
 * stored.
 *
 * No React and no Next imports, so lib/accounting-format.spec.ts can run it.
 */

/** YYYY-MM-DD of `now` where the salon is. */
export function salonDay(now: Date, timeZone: string): string {
  const fmt = (tz: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  try {
    return fmt(timeZone || "Europe/Madrid");
  } catch {
    return fmt("Europe/Madrid");
  }
}

/** The first day of the calendar quarter of a YYYY-MM-DD day. */
export function quarterStartOf(day: string): string {
  const [y, m] = day.split("-").map(Number);
  const startMonth = Math.floor((m - 1) / 3) * 3 + 1;
  return `${y}-${String(startMonth).padStart(2, "0")}-01`;
}

const ACTIONS = new Set(["sync", "cancel", "connect", "unlink", "retry", "refresh_token"]);
const STATUSES = new Set(["ok", "error", "skipped"]);

/** accounting.logActions.* (Enviada, Anulación, Conexión...). */
export function accountingActionKey(action: string): string {
  return ACTIONS.has(action) ? `accounting.logActions.${action}` : "accounting.logActions.other";
}

/**
 * accounting.logStatuses.*. A failed cancellation is the «No reflejado en
 * Holded» the page's note talks about.
 */
export function accountingStatusKey(action: string, status: string): string {
  if (action === "cancel" && status === "error") return "accounting.logStatuses.notReflected";
  return STATUSES.has(status) ? `accounting.logStatuses.${status}` : "accounting.logStatuses.other";
}
