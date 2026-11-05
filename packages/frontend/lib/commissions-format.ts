/**
 * Amounts and dates on the Comisiones page (summary and payroll tabs).
 *
 * The commissions API returns every money figure in cents: a visit's
 * `amount` (appointments.totalAmount), `commissionAmount`, the summary's
 * `pendingCommission` / `paidCommission` / `totalEarnings`, and the payroll's
 * `totalSales` / `commission` / `refundAdjustments` / `totalPayroll`. The page
 * printed them as euros, so 30,00 € read as 3.000,00 €. Everything goes
 * through `formatCommissionCents` now: euros the Spanish way, "1.234,56 €".
 */

// es-ES only groups thousands from 10.000 on ("1234,56 €"); "always" gives
// "1.234,56 €". Browsers without it fall back to the default grouping.
const EUROS = new Intl.NumberFormat("es-ES", {
  style: "currency",
  currency: "EUR",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
  ...({ useGrouping: "always" } as unknown as Intl.NumberFormatOptions),
});

/** 123456 -> "1.234,56 €"; -100 -> "-1,00 €"; nothing -> "0,00 €". */
export function formatCommissionCents(cents: number | null | undefined): string {
  const value = typeof cents === "number" && Number.isFinite(cents) ? cents : 0;
  return EUROS.format(Math.round(value) / 100);
}

/** Commission as a share of sales ("10,0 %"); both in cents, so the unit cancels. */
export function commissionShare(commissionCents: number, salesCents: number): string {
  const share = salesCents > 0 ? (commissionCents / salesCents) * 100 : 0;
  return `${share.toLocaleString("es-ES", { minimumFractionDigits: 1, maximumFractionDigits: 1 })} %`;
}

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * "2026-11-30" -> "30 nov 2026", as the calendar day it is (no timezone
 * shift). Full timestamps are shown in the browser's day.
 */
export function formatCommissionDay(value: string | null | undefined): string {
  if (!value) return "—";
  const m = DAY_RE.exec(value);
  const date = m ? new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))) : new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString("es-ES", {
    year: "numeric",
    month: "short",
    day: "numeric",
    ...(m ? { timeZone: "UTC" } : {}),
  });
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The payroll's default period: the 1st of this month to today, in the browser's calendar. */
export function defaultPayrollRange(now: Date = new Date()): { startDate: string; endDate: string } {
  const y = now.getFullYear();
  const m = pad(now.getMonth() + 1);
  return { startDate: `${y}-${m}-01`, endDate: `${y}-${m}-${pad(now.getDate())}` };
}

/**
 * "Fin del mes pasado" in the "Pagar" dialog: the last day of the month
 * before the given salon day ("2026-11-04" -> "2026-10-31").
 */
export function lastDayOfPreviousMonth(day: string): string {
  const m = DAY_RE.exec(day);
  if (!m) return day;
  // Day 0 of this month is the last day of the previous one.
  const last = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 0));
  return `${last.getUTCFullYear()}-${pad(last.getUTCMonth() + 1)}-${pad(last.getUTCDate())}`;
}

/**
 * A percent typed in the commission settings ("10", "12,5"): the number, or
 * null when it is not one between 0 and 100 (two decimals at most).
 */
export function percentFromField(text: string): number | null {
  const value = text.trim().replace(",", ".");
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(value)) return null;
  const n = Number(value);
  return n >= 0 && n <= 100 ? n : null;
}

/**
 * The rate that applies to a professional: their own (0 included) or, when
 * they have none, the salon's default -- what the professional's file shows,
 * "10 % (por defecto del salón)".
 */
export function effectiveProfessionalRate(
  own: number | string | null | undefined,
  salonDefault: number | null | undefined,
): { rate: number | null; fromSalon: boolean } {
  const parsed = own === null || own === undefined || own === "" ? NaN : Number(own);
  if (Number.isFinite(parsed)) return { rate: parsed, fromSalon: false };
  return { rate: typeof salonDefault === "number" && Number.isFinite(salonDefault) ? salonDefault : null, fromSalon: true };
}

/** 12.5 -> "12,5 %". */
export function formatPercent(rate: number): string {
  return `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 }).format(rate)} %`;
}
