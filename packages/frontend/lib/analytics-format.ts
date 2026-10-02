/**
 * Formatting and small derived figures for the analytics screens.
 *
 * The analytics API returns money in cents (the unit of the appointments
 * table and of payments). The home dashboard divided by 100; the analytics
 * page did not, so the same month read 100 times larger there. Every money
 * figure on these screens goes through `formatCents`.
 */

export function formatCents(cents: number | null | undefined): string {
  const euros = Number(cents ?? 0) / 100;
  return new Intl.NumberFormat("es-ES", {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: Number.isInteger(euros) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(euros);
}

/** "37,5 %" or "—" when the rate could not be measured. */
export function formatRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return "—";
  return `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 1 }).format(rate)} %`;
}

/**
 * Change of the last 7 days against the 7 days before them, from the counts
 * of the last 7 and the last 14 days. The panel used to compare the last 7
 * days with half of the last 14 -- a window that contains them.
 * Null when the earlier week had no appointments.
 */
export function weekOverWeekChange(last7: number, last14: number): number | null {
  const previous7 = last14 - last7;
  if (previous7 <= 0) return null;
  return Math.round(((last7 - previous7) / previous7) * 100);
}

/** "1 oct – 31 oct 2026" for a {start, end} pair of YYYY-MM-DD days. */
export function formatPeriod(period: { start: string; end: string } | null | undefined): string {
  if (!period) return "";
  const fmt = (day: string, withYear: boolean) =>
    new Intl.DateTimeFormat("es-ES", {
      day: "numeric",
      month: "short",
      ...(withYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    }).format(new Date(`${day}T00:00:00Z`));
  return `${fmt(period.start, period.start.slice(0, 4) !== period.end.slice(0, 4))} – ${fmt(period.end, true)}`;
}
