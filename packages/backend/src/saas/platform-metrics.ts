import { BadRequestException } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { monthStart, salonToday } from "../analytics/analytics-metrics";
import { salonInstant } from "../appointments/salon-time";
import { COUNTABLE_TENANT_WHERE } from "./saas.constants";

/**
 * Pure helpers behind the console's platform figures (audit 8 D4, D5, D12).
 * Kept apart from the service so the rules can be tested without a database.
 */

/** The console counts months on the founder's clock, not UTC. */
export const CONSOLE_TIME_ZONE = "Europe/Madrid";

/**
 * Salons that count in the platform figures: not deleted and not one of
 * our own salons (Tenant.isInternal: the Platform tenant and our test
 * salons, audit 8 D11). Same predicate as countableTenantWhere.
 */
export const PLATFORM_TENANT_WHERE: Prisma.TenantWhereInput = { ...COUNTABLE_TENANT_WHERE };

/**
 * A salon pays KiraRoom when it is `active` on a Stripe subscription. An
 * `active` salon without one (reactivated by hand from the console, or a
 * manual grant) bills nothing: it is counted apart, as "active without
 * billing", and stays out of MRR.
 */
export const PAYING_TENANT_WHERE: Prisma.TenantWhereInput = {
  ...PLATFORM_TENANT_WHERE,
  subscriptionStatus: "active",
  stripeSubscriptionId: { not: null },
};

export const MAX_MONTHS = 24;
export const DEFAULT_MONTHS = 6;

/** `?months=`: an integer from 1 to 24 (6 when absent). Anything else is a 400. */
export function parseMonthsParam(raw: string | undefined): number {
  if (raw === undefined || raw === "") return DEFAULT_MONTHS;
  if (!/^\d+$/.test(raw.trim())) {
    throw new BadRequestException(`months must be an integer from 1 to ${MAX_MONTHS}`);
  }
  const n = Number(raw);
  return Math.min(MAX_MONTHS, Math.max(1, n));
}

export interface ConsoleMonth {
  /** YYYY-MM */
  month: string;
  /** First instant of the month in Madrid. */
  start: Date;
  /** First instant of the next month in Madrid (exclusive). */
  end: Date;
  /** First and last calendar day, for @db.Date-like columns. */
  firstDay: string;
  nextFirstDay: string;
}

/**
 * The last `count` months on the Madrid calendar (or the given time zone),
 * oldest first, ending with the current one.
 */
export function consoleMonths(count: number, now: Date = new Date(), timeZone: string = CONSOLE_TIME_ZONE): ConsoleMonth[] {
  const today = salonToday(timeZone, now);
  const out: ConsoleMonth[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const firstDay = monthStart(today, -i);
    const nextFirstDay = monthStart(today, -i + 1);
    out.push({
      month: firstDay.slice(0, 7),
      firstDay,
      nextFirstDay,
      start: salonInstant(firstDay, "00:00", timeZone),
      end: salonInstant(nextFirstDay, "00:00", timeZone),
    });
  }
  return out;
}

/** Prisma filter on `scheduledDate` (stored as the UTC midnight of the visit day) for a month. */
export function scheduledInMonth(month: Pick<ConsoleMonth, "firstDay" | "nextFirstDay">): { gte: Date; lt: Date } {
  return { gte: new Date(`${month.firstDay}T00:00:00.000Z`), lt: new Date(`${month.nextFirstDay}T00:00:00.000Z`) };
}

/** Percentage change, or null when there is no previous value to compare with. */
export function percentChange(current: number, previous: number): number | null {
  if (!(previous > 0)) return null;
  return Math.round(((current - previous) / previous) * 10000) / 100;
}

/** A ratio as a percentage with two decimals, or null without a denominator. */
export function percentOf(part: number, whole: number): number | null {
  if (!(whole > 0)) return null;
  return Math.round((part / whole) * 10000) / 100;
}

export interface LifecycleTenant {
  createdAt: Date;
  cancelledAt: Date | null;
  firstPaidAt: Date | null;
  trialEnd: Date | null;
}

export interface MonthLifecycle {
  newSalons: number;
  /** Salons that had paid KiraRoom and cancelled in the month. */
  paidCancellations: number;
  /** Salons that cancelled (or whose trial expired) in the month without ever paying. */
  expiredTrials: number;
  /** Trials whose end date fell in the month (and has passed). */
  trialsEnded: number;
  /** Of those, how many have paid KiraRoom. */
  trialsConverted: number;
  /** trialsConverted / trialsEnded, as a percentage; null with no trial ending. */
  trialConversionRate: number | null;
}

const within = (d: Date | null, from: Date, to: Date) => !!d && d >= from && d < to;

/**
 * What happened to salons in one month, from the lifecycle dates (not from
 * the current status nor `updatedAt`, which any later edit moves).
 *
 * - A cancellation is the month of `cancelledAt`. It is a paid one when the
 *   salon had paid KiraRoom (`firstPaidAt`), an expired trial otherwise.
 * - Trial conversion: of the salons whose trial ended in the month, the
 *   share that has paid.
 *
 * Caveat: `firstPaidAt` exists since 2026-11-04 and was backfilled only for
 * salons active on Stripe at the time, so a paying salon that cancelled
 * before then reads as an expired trial.
 */
export function monthLifecycle(tenants: LifecycleTenant[], month: Pick<ConsoleMonth, "start" | "end">, now: Date = new Date()): MonthLifecycle {
  const trialCutoff = month.end < now ? month.end : now;
  let newSalons = 0;
  let paidCancellations = 0;
  let expiredTrials = 0;
  let trialsEnded = 0;
  let trialsConverted = 0;
  for (const t of tenants) {
    if (within(t.createdAt, month.start, month.end)) newSalons++;
    if (within(t.cancelledAt, month.start, month.end)) {
      if (t.firstPaidAt && t.firstPaidAt <= (t.cancelledAt as Date)) paidCancellations++;
      else expiredTrials++;
    }
    if (within(t.trialEnd, month.start, trialCutoff)) {
      trialsEnded++;
      if (t.firstPaidAt) trialsConverted++;
    }
  }
  return {
    newSalons,
    paidCancellations,
    expiredTrials,
    trialsEnded,
    trialsConverted,
    trialConversionRate: percentOf(trialsConverted, trialsEnded),
  };
}

/**
 * Monthly churn of paying salons: paid cancellations in the month over the
 * salons that were paying during it. The base is approximated as the salons
 * paying now plus those that left in the month (there is no history table
 * of statuses), so it ignores salons that started paying mid-month.
 */
export function paidChurnRate(paidCancellations: number, payingNow: number): number | null {
  return percentOf(paidCancellations, payingNow + paidCancellations);
}
