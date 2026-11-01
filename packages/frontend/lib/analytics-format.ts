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

/**
 * A change in percent as "+12,5 %", "-3 %" or "0 %"; "—" when there was
 * nothing to compare with (the API sends null when the previous figure is 0).
 */
export function formatPercentChange(change: number | null | undefined): string {
  if (change === null || change === undefined || !Number.isFinite(change)) return "—";
  return `${new Intl.NumberFormat("es-ES", {
    maximumFractionDigits: 1,
    signDisplay: "exceptZero",
  }).format(change)} %`;
}

function monthDate(month: string): Date | null {
  const m = /^(\d{4})-(\d{2})/.exec(month ?? "");
  if (!m) return null;
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * "oct" for the API's "YYYY-MM" (or "YYYY-MM-DD"); "oct 2026" with `withYear`.
 * The page used to look these up as analytics.months.* keys that never
 * existed, so every bar was labelled "analytics.months.oct".
 */
export function formatMonth(month: string, opts: { withYear?: boolean; locale?: string } = {}): string {
  const date = monthDate(month);
  if (!date) return month ?? "";
  return new Intl.DateTimeFormat(opts.locale ?? "es-ES", {
    month: "short",
    ...(opts.withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  })
    .format(date)
    .replace(".", "");
}

/** "ago – oct 2026" (or "dic 2025 – feb 2026") for the first and last "YYYY-MM". */
export function formatMonthRange(first: string, last: string): string {
  if (!first || !last) return "";
  const sameYear = first.slice(0, 4) === last.slice(0, 4);
  if (first.slice(0, 7) === last.slice(0, 7)) return formatMonth(last, { withYear: true });
  return `${formatMonth(first, { withYear: !sameYear })} – ${formatMonth(last, { withYear: true })}`;
}

/**
 * The page's period presets: the same range ids as Multi-local's consolidated
 * report and the API's `range` (backend rangePeriod), so both screens speak
 * of the same periods.
 */
export const ANALYTICS_RANGES = [
  "this_month",
  "last_month",
  "last_30_days",
  "3_months",
  "6_months",
  "12_months",
] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];

export function isAnalyticsRange(value: unknown): value is AnalyticsRange {
  return typeof value === "string" && (ANALYTICS_RANGES as readonly string[]).includes(value);
}

/** Months of history a range reaches back: 1-2 for the short ones, N for "N_months". */
export function rangeHistoryMonths(range: AnalyticsRange): number {
  const m = /^(\d+)_months$/.exec(range);
  if (m) return Number(m[1]);
  return range === "this_month" ? 1 : 2;
}

function planMonths(maxMonths: number | null | undefined): number {
  return Math.max(3, Number(maxMonths) || 3);
}

/** The presets the plan can show (Esencial 3 months, Pro 6, Empresa 12). */
export function rangeOptions(maxMonths: number | null | undefined): AnalyticsRange[] {
  const max = planMonths(maxMonths);
  return ANALYTICS_RANGES.filter((r) => rangeHistoryMonths(r) <= max);
}

/** `range` when the plan shows it, else its longest preset (e.g. after a downgrade). */
export function clampRange(range: AnalyticsRange, maxMonths: number | null | undefined): AnalyticsRange {
  const options = rangeOptions(maxMonths);
  return options.includes(range) ? range : options[options.length - 1];
}

/**
 * Months of the status evolution charts for a preset: the preset's months, or
 * 3 for the short ones (one bar says nothing about a trend); never more than
 * the plan.
 */
export function evolutionMonthsFor(range: AnalyticsRange, maxMonths: number | null | undefined): number {
  const m = /^(\d+)_months$/.exec(range);
  return Math.min(m ? Number(m[1]) : 3, planMonths(maxMonths));
}

/** The translation key of a preset's label. */
export function rangeLabelKey(range: string): string {
  const m = /^(\d+)_months$/.exec(range);
  return m ? `analytics.last_${m[1]}_months` : `analytics.${range}`;
}

/** "12 oct" for a "YYYY-MM-DD" day; "12 oct 2026" with `withYear`. */
export function formatDay(day: string, opts: { withYear?: boolean } = {}): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day ?? "");
  if (!m) return day ?? "";
  const date = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat("es-ES", {
    day: "numeric",
    month: "short",
    ...(opts.withYear ? { year: "numeric" } : {}),
    timeZone: "UTC",
  })
    .format(date)
    .replace(".", "");
}
