/**
 * How an invoice is numbered and dated.
 *
 * Numbers are correlative per (salon, series, year) -- FiscalSequence -- and
 * unique per (salon, series, number) in the database. Up to 2026 the stored
 * number had no year ("000123"), so on 1 January the new year's counter
 * started again at 000001 and collided with the previous year's invoice of
 * the same series: every invoice of a series already used failed from then
 * on. From 2027 the number carries its year: "2027-000001" (shown as
 * A2027-000001). 2026 keeps the old format so this year's sequence stays
 * correlative with the invoices already issued; 2026 is the only year with
 * a counter in the old format, so nothing collides.
 *
 * The year and the issue date are the salon's (Europe/Madrid,
 * Atlantic/Canary), not UTC's: an invoice at 00:30 on 1 January in Madrid is
 * 2027's, though it is still 31 December in UTC. The issue date is stored as
 * that calendar day at 00:00 UTC, the way a manual invoice's "YYYY-MM-DD"
 * always was, so everything that reads it as a UTC day (the AEAT records,
 * the QR, Holded, the invoice book, the quarter of a tax report) gets the
 * salon's day.
 */
import { DEFAULT_SALON_TIMEZONE } from "@kira/shared";

/** The first year whose invoice numbers carry the year. */
export const FIRST_YEAR_WITH_YEAR_IN_NUMBER = 2027;

/** Rectificativas (InvoiceService.emitRectification): never a manual invoice's. */
export const RECTIFICATION_SERIES = "R";

/** Simplified invoices (tickets) of sales at the till: never a manual invoice's. */
export const SIMPLIFIED_SERIES = "T";

/** Series a manual invoice cannot use: they are issued by KiraRoom itself. */
export const RESERVED_SERIES: readonly string[] = [RECTIFICATION_SERIES, SIMPLIFIED_SERIES];

/** The stored number of the `n`th invoice of a series in `year`. */
export function formatInvoiceNumber(year: number, n: number): string {
  const counter = String(n).padStart(6, "0");
  return year >= FIRST_YEAR_WITH_YEAR_IN_NUMBER ? `${year}-${counter}` : counter;
}

/** The salon's calendar day ("YYYY-MM-DD") at `instant`. */
export function salonDay(instant: Date, timeZone: string | null | undefined): string {
  const format = (tz: string) =>
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(
      instant,
    );
  try {
    return format(timeZone || DEFAULT_SALON_TIMEZONE);
  } catch {
    // An unknown zone name in the salon's row: Spain's.
    return format(DEFAULT_SALON_TIMEZONE);
  }
}

/** A calendar day as an issue date: that day at 00:00 UTC. */
export function issueDateOfDay(day: string): Date {
  return new Date(`${day.slice(0, 10)}T00:00:00.000Z`);
}

/**
 * The calendar day of an issue date given to the service: a "YYYY-MM-DD"
 * parsed to 00:00 UTC (a manual invoice) is that day; any other instant is
 * the salon's day at that instant.
 */
export function dayOfIssueDate(issueDate: Date, timeZone: string | null | undefined): string {
  const iso = issueDate.toISOString();
  return iso.endsWith("T00:00:00.000Z") ? iso.slice(0, 10) : salonDay(issueDate, timeZone);
}
