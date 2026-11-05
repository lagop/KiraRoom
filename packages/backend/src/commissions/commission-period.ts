import { instantRange, scheduledDateRange } from "../analytics/analytics-metrics";

/**
 * The payroll and payout periods are calendar days picked in the panel
 * ("YYYY-MM-DD", from and to, both included). They used to be filtered as
 * `lte <end day at 00:00 UTC>`, which left out the whole last day.
 *
 * Here both ends are whole salon days:
 *  - appointments by `scheduledDate` (stored as the calendar day at 00:00
 *    UTC): from the first day to the day after the last, exclusive;
 *  - sale lines and refund adjustments by `createdAt` (real instants): from
 *    the salon's midnight of the first day to the salon's midnight after the
 *    last, exclusive, in the salon's timezone.
 */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The calendar day of a period bound: "YYYY-MM-DD" (or a full ISO string), or a Date. */
export function periodDay(value: Date | string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value === "string") {
    const day = value.slice(0, 10);
    return DAY_RE.test(day) && !Number.isNaN(new Date(`${day}T00:00:00Z`).getTime()) ? day : null;
  }
  // A date-only value arrives as 00:00 UTC of that day (`new Date("2026-11-30")`).
  return Number.isNaN(value.getTime()) ? null : value.toISOString().slice(0, 10);
}

export interface CommissionPeriodFilters {
  /** For `appointments.scheduledDate`. */
  scheduledDate?: { gte?: Date; lt?: Date };
  /** For `createdAt` of sale lines and refund adjustments. */
  createdAt?: { gte?: Date; lt?: Date };
}

/** Prisma filters for a period whose both days are included; either end may be open. */
export function commissionPeriodFilters(
  start: Date | string | null | undefined,
  end: Date | string | null | undefined,
  timeZone: string,
): CommissionPeriodFilters {
  let first = periodDay(start);
  let last = periodDay(end);
  if (first && last && first > last) [first, last] = [last, first];
  if (!first && !last) return {};
  const scheduled = scheduledDateRange({ start: first ?? last!, end: last ?? first! });
  const created = instantRange({ start: first ?? last!, end: last ?? first! }, timeZone);
  return {
    scheduledDate: { ...(first ? { gte: scheduled.gte } : {}), ...(last ? { lt: scheduled.lt } : {}) },
    createdAt: { ...(first ? { gte: created.gte } : {}), ...(last ? { lt: created.lt } : {}) },
  };
}
