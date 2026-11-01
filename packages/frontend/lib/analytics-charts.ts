/**
 * Pure figures behind the analytics charts (app/dashboard/analytics).
 *
 * The page used to compute these inline, twice for the two donuts and once
 * per insight with a fresh find(). Keeping them here lets the components stay
 * presentational and lets the specs pin the geometry and the summaries that
 * screen readers get instead of the bars.
 */

/** The three statuses of the evolution charts, in stacking order (bottom up). */
export const EVOLUTION_STATUSES = ["Completed", "Cancelled", "No Show"] as const;
export type EvolutionStatus = (typeof EVOLUTION_STATUSES)[number];

export interface StatusCount {
  name: string;
  count: number;
}

export interface EvolutionRow {
  /** "YYYY-MM" */
  period: string;
  Completed: number;
  Cancelled: number;
  "No Show": number;
}

/** Circumference of the donut circle (r = 40 in a 100×100 viewBox). */
export const DONUT_CIRCUMFERENCE = 2 * Math.PI * 40;

export interface DonutSegment {
  name: string;
  count: number;
  /** Share of the total, in percent (not rounded). */
  percentage: number;
  /** stroke-dasharray / stroke-dashoffset for the circle. */
  dashArray: string;
  dashOffset: number;
}

/** One arc per status, each starting where the previous one ended. */
export function donutSegments(items: ReadonlyArray<StatusCount>): {
  total: number;
  segments: DonutSegment[];
} {
  const total = items.reduce((sum, s) => sum + Math.max(0, s.count), 0);
  let before = 0;
  const segments = items.map((s) => {
    const share = total > 0 ? Math.max(0, s.count) / total : 0;
    const length = share * DONUT_CIRCUMFERENCE;
    const segment: DonutSegment = {
      name: s.name,
      count: s.count,
      percentage: share * 100,
      dashArray: `${length} ${DONUT_CIRCUMFERENCE - length}`,
      dashOffset: DONUT_CIRCUMFERENCE - before,
    };
    before += length;
    return segment;
  });
  return { total, segments };
}

/**
 * Whole-percent share of each status ("Completed" → 50), null when there is
 * nothing to divide by. One pass, instead of a find() per rate.
 */
export function statusShares(items: ReadonlyArray<StatusCount>): {
  total: number;
  share: (name: string) => number | null;
} {
  const counts = new Map<string, number>();
  let total = 0;
  for (const s of items) {
    counts.set(s.name, (counts.get(s.name) ?? 0) + s.count);
    total += s.count;
  }
  return {
    total,
    share: (name) =>
      total > 0 ? Math.round(((counts.get(name) ?? 0) / total) * 100) : null,
  };
}

export interface StackedColumn {
  period: string;
  total: number;
  /** Bottom-up segments, height and offset in percent of the tallest column. */
  segments: { status: EvolutionStatus; count: number; height: number; bottom: number }[];
}

/** The stacked monthly evolution, scaled to the tallest month. */
export function stackedEvolution(rows: ReadonlyArray<EvolutionRow>): StackedColumn[] {
  const totals = rows.map((r) => EVOLUTION_STATUSES.reduce((s, k) => s + (r[k] || 0), 0));
  const max = Math.max(...totals, 1);
  return rows.map((r, i) => {
    let bottom = 0;
    const segments = EVOLUTION_STATUSES.map((status) => {
      const count = r[status] || 0;
      const height = (count / max) * 100;
      const segment = { status, count, height, bottom };
      bottom += height;
      return segment;
    });
    return { period: r.period, total: totals[i], segments };
  });
}

/** Month by month, the share of one status among the three, in percent. */
export function statusShareSeries(
  rows: ReadonlyArray<EvolutionRow>,
  status: EvolutionStatus,
): { period: string; count: number; percentage: number }[] {
  return rows.map((r) => {
    const total = EVOLUTION_STATUSES.reduce((s, k) => s + (r[k] || 0), 0);
    const count = r[status] || 0;
    return { period: r.period, count, percentage: total > 0 ? (count / total) * 100 : 0 };
  });
}

/** Bar width in percent of the largest value (0 when every value is 0). */
export function barWidth(value: number, max: number): number {
  if (!(max > 0) || !(value > 0)) return 0;
  return Math.min(100, (value / max) * 100);
}

export interface DailyPoint {
  /** "YYYY-MM-DD" */
  date: string;
  appointments: number;
  /** Cents. */
  revenue: number;
}

/**
 * The polyline of a daily series in a width×height box (y grows downwards,
 * 0 at the bottom). A single day is drawn as a flat line across the box.
 */
export function linePoints(
  values: ReadonlyArray<number>,
  width: number,
  height: number,
): { x: number; y: number }[] {
  if (values.length === 0) return [];
  const max = Math.max(...values, 0);
  const step = values.length > 1 ? width / (values.length - 1) : 0;
  const y = (v: number) => (max > 0 ? height - (Math.max(0, v) / max) * height : height);
  if (values.length === 1) return [{ x: 0, y: y(values[0]) }, { x: width, y: y(values[0]) }];
  return values.map((v, i) => ({ x: i * step, y: y(v) }));
}

/** "M0,10 L5,4 …" for an SVG path. */
export function pathFrom(points: ReadonlyArray<{ x: number; y: number }>): string {
  return points
    .map((p, i) => `${i === 0 ? "M" : "L"}${round2(p.x)},${round2(p.y)}`)
    .join(" ");
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/** Totals and the busiest day of a daily series (null when every day is 0). */
export function dailySummary(
  days: ReadonlyArray<DailyPoint>,
  metric: "revenue" | "appointments",
): { total: number; best: DailyPoint | null; activeDays: number } {
  let total = 0;
  let best: DailyPoint | null = null;
  let activeDays = 0;
  for (const d of days) {
    const v = d[metric] || 0;
    total += v;
    if (v > 0) activeDays++;
    if (v > 0 && (!best || v > (best[metric] || 0))) best = d;
  }
  return { total, best, activeDays };
}

/**
 * The text a screen reader gets for a bar chart: "oct: 1.200 €; nov: 900 €".
 * The components pass the label and value formatters.
 */
export function describeSeries<T>(
  rows: ReadonlyArray<T>,
  label: (row: T) => string,
  value: (row: T) => string,
): string {
  return rows.map((r) => `${label(r)}: ${value(r)}`).join("; ");
}

/**
 * Hands out request ids so only the latest response of a series is applied.
 * Changing the period twice quickly used to let the slower, older answer
 * overwrite the newer one.
 */
export function createLatestGuard(): {
  begin: () => number;
  isLatest: (id: number) => boolean;
  /** Invalidates every request in flight (unmount, key change). */
  cancel: () => void;
} {
  let current = 0;
  return {
    begin: () => ++current,
    isLatest: (id) => id === current,
    cancel: () => {
      current++;
    },
  };
}
