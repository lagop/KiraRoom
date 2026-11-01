/**
 * The arithmetic behind every analytics figure, kept free of Prisma so it can
 * be tested with fixed data.
 *
 * Why this file exists: the analytics screens used to show numbers that were
 * not measured. "Clientas recurrentes" was `citas × 0,4`; revenue counted
 * confirmed appointments nobody had paid yet; months were cut with the
 * server's clock (UTC in production) instead of the salon's; the "vs last
 * month" change compared six months against one; and money was summed in
 * cents on one card and in euros on the next. Each definition below says what
 * is counted, so the panel can say the same in its tooltips.
 *
 * Money is always in **cents** (the unit of `appointments.totalAmount`,
 * `appointments.amountPaid` and `payments.amount`).
 */

import { salonInstant } from "../appointments/salon-time";
import { workingWindowsFor } from "../appointments/working-hours";
import { TimeOffBlock, availableWindows, dayBlocks } from "../time-off/time-off-rules";
import { appointmentBusyBlocks, freesProfessional, isLiveRow, rowService, toCents } from "../appointments/visit-totals";
import { loyaltyMoneyCents } from "../invoices/appointment-invoice-pricing";
import { allocateCents } from "../pos/pos-discounts";

// ---------------------------------------------------------------------------
// Periods
// ---------------------------------------------------------------------------

/**
 * A run of calendar days in the salon's timezone, both ends inclusive, as
 * "YYYY-MM-DD". Appointments store their day as a calendar date (the UTC day
 * of `scheduledDate` is the salon's day), so periods are expressed in days,
 * not instants.
 */
export interface SalonPeriod {
  start: string;
  end: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Today's date on the salon's wall calendar. */
export function salonToday(timeZone: string, now: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(now);
}

function toUtcDate(day: string): Date {
  return new Date(`${day.slice(0, 10)}T00:00:00.000Z`);
}

function fromUtcDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return fromUtcDate(new Date(toUtcDate(day).getTime() + days * DAY_MS));
}

/** First day of the month `months` away from `day`'s month. */
export function monthStart(day: string, months = 0): string {
  const d = toUtcDate(day);
  return fromUtcDate(new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1)));
}

/**
 * The same day-of-month `months` away, clamped to that month's last day
 * (31 March minus one month is 28/29 February, not 3 March).
 */
export function shiftMonths(day: string, months: number): string {
  const d = toUtcDate(day);
  const target = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(d.getUTCDate(), lastDay));
  return fromUtcDate(target);
}

/**
 * The longest period any analytics figure is computed over: twelve calendar
 * months cut at today never exceed 366 days.
 */
export const MAX_PERIOD_DAYS = 366;

/**
 * Every day of the period. Counted rather than compared as strings: past
 * 9999-12-31 addDays gives "+010000-01-01", which sorts before any end date,
 * so a string loop never ended and froze the server. A period longer than
 * MAX_PERIOD_DAYS (or not a period at all) is a programming error, never a
 * reason to loop.
 */
export function daysIn(period: SalonPeriod): string[] {
  const n = periodLength(period);
  if (!Number.isFinite(n) || n > MAX_PERIOD_DAYS) {
    throw new Error(`Analytics period too long: ${period.start} to ${period.end}`);
  }
  const days: string[] = [];
  for (let i = 0; i < n; i++) days.push(addDays(period.start, i));
  return days;
}

export function periodLength(period: SalonPeriod): number {
  return Math.round((toUtcDate(period.end).getTime() - toUtcDate(period.start).getTime()) / DAY_MS) + 1;
}

/**
 * The last `months` calendar months, the current one included and cut at
 * today: months=1 is "this month so far", months=3 is the two previous months
 * plus this month so far.
 */
export function lastMonthsPeriod(today: string, months: number): SalonPeriod {
  const n = Math.max(1, Math.floor(months) || 1);
  return { start: monthStart(today, -(n - 1)), end: today };
}

/**
 * The period to compare against. A month-aligned period is compared with the
 * same days `months` months earlier (1-2 October against 1-2 September), so a
 * month that has only just started is not set against a whole month. Any
 * other period is compared with the equally long run of days just before it.
 */
export function previousPeriod(period: SalonPeriod, months?: number): SalonPeriod {
  if (months && months > 0) {
    return {
      start: shiftMonths(period.start, -months),
      end: shiftMonths(period.end, -months),
    };
  }
  const len = periodLength(period);
  const end = addDays(period.start, -1);
  return { start: addDays(end, -(len - 1)), end };
}

/** Prisma filter for `appointments.scheduledDate` (a calendar day). */
export function scheduledDateRange(period: SalonPeriod): { gte: Date; lt: Date } {
  return { gte: toUtcDate(period.start), lt: toUtcDate(addDays(period.end, 1)) };
}

/** Prisma filter for real instants (`createdAt`), cut at the salon's midnight. */
export function instantRange(period: SalonPeriod, timeZone: string): { gte: Date; lt: Date } {
  return {
    gte: salonInstant(period.start, "00:00", timeZone),
    lt: salonInstant(addDays(period.end, 1), "00:00", timeZone),
  };
}

/** The salon calendar day an appointment belongs to. */
export function appointmentDay(scheduledDate: Date | string): string {
  return typeof scheduledDate === "string"
    ? scheduledDate.slice(0, 10)
    : scheduledDate.toISOString().slice(0, 10);
}

export const RANGE_KEYS = [
  "today",
  "this_week",
  "last_week",
  "this_month",
  "last_month",
  "last_30_days",
  "3_months",
  "6_months",
  "12_months",
] as const;
export type RangeKey = (typeof RANGE_KEYS)[number];

/**
 * A named range ("this_month", "last_week"...) as salon calendar days. Weeks
 * start on Monday. `maxMonths` is the plan's history limit: a longer range is
 * cut to it. Unknown keys fall back to this month.
 */
export function rangePeriod(range: string | undefined, today: string, maxMonths = 12): SalonPeriod {
  const weekday = (toUtcDate(today).getUTCDay() + 6) % 7; // Monday = 0
  const thisMonday = addDays(today, -weekday);
  const months = (n: number) => lastMonthsPeriod(today, Math.min(n, maxMonths));
  switch (range === "1_year" ? "12_months" : range) {
    case "today":
      return { start: today, end: today };
    case "this_week":
      return { start: thisMonday, end: today };
    case "last_week":
      return { start: addDays(thisMonday, -7), end: addDays(thisMonday, -1) };
    case "last_month":
      return { start: monthStart(today, -1), end: addDays(monthStart(today), -1) };
    case "last_30_days":
      return { start: addDays(today, -29), end: today };
    case "3_months":
      return months(3);
    case "6_months":
      return months(6);
    case "12_months":
      return months(12);
    case "this_month":
    default:
      return { start: monthStart(today), end: today };
  }
}

/**
 * A `range` query value as a RangeKey ("1_year" is the old name of
 * "12_months"); null for anything else, so an endpoint can answer 400 instead
 * of quietly showing this month.
 */
export function parseRangeKey(range: string | undefined | null): RangeKey | null {
  if (typeof range !== "string") return null;
  const key = range === "1_year" ? "12_months" : range;
  return (RANGE_KEYS as readonly string[]).includes(key) ? (key as RangeKey) : null;
}

/** The months of an "N_months" range after the plan's limit; null for the others. */
function rangeMonths(range: RangeKey, maxMonths: number): number | null {
  const m = /^(\d+)_months$/.exec(range);
  return m ? Math.max(1, Math.min(Number(m[1]), maxMonths)) : null;
}

/**
 * What a named range is compared with ("vs. mismo período anterior"):
 * - this month so far: the same days of last month (previousPeriod);
 * - last month: the whole month before it (September against all of August,
 *   not 1-30 August);
 * - the last N months: the same days N months earlier (N after the plan's cut);
 * - a week: the same weekdays a week earlier;
 * - today and the last 30 days: the equally long run of days just before.
 */
export function comparisonPeriod(range: RangeKey, period: SalonPeriod, maxMonths = 12): SalonPeriod {
  const months = rangeMonths(range, maxMonths);
  if (months) return previousPeriod(period, months);
  switch (range) {
    case "this_month":
      return previousPeriod(period, 1);
    case "last_month":
      return { start: monthStart(period.start, -1), end: addDays(period.start, -1) };
    case "this_week":
    case "last_week":
      return { start: addDays(period.start, -7), end: addDays(period.end, -7) };
    default:
      return previousPeriod(period);
  }
}

/**
 * What an analytics request asks for: the last N months (the old `months`
 * parameter, already cut to the plan) or a named range with the plan's limit.
 */
export type PeriodWindow = number | { range: RangeKey; maxMonths: number };

/** The period of a window and the one it is compared with. */
export function windowPeriods(window: PeriodWindow, today: string): { period: SalonPeriod; previous: SalonPeriod } {
  if (typeof window === "number") {
    const period = lastMonthsPeriod(today, window);
    return { period, previous: previousPeriod(period, window) };
  }
  const period = rangePeriod(window.range, today, window.maxMonths);
  return { period, previous: comparisonPeriod(window.range, period, window.maxMonths) };
}

/**
 * A real calendar day as "YYYY-MM-DD", years 2000-2100 only; null otherwise.
 * The round trip rejects days that do not exist: Date reads 2026-02-31 as
 * 3 March.
 */
export function parseSalonDay(value: string | undefined | null): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const year = Number(value.slice(0, 4));
  if (year < 2000 || year > 2100) return null;
  const date = toUtcDate(value);
  if (Number.isNaN(date.getTime()) || fromUtcDate(date) !== value) return null;
  return value;
}

/**
 * An explicit start/end pair (both "YYYY-MM-DD", both inclusive), checked
 * before anything is loaded for it: real days in 2000-2100, end not before
 * start, and no longer than `maxMonths` months of 30.5 days (the plan's
 * history, 1-12) nor MAX_PERIOD_DAYS. The error is the Spanish sentence a
 * 400 carries.
 *
 * No endpoint takes explicit dates today (the reports that did had no caller
 * and were removed); one that does must go through this. An unchecked range
 * once froze the server (see daysIn).
 */
export function explicitPeriod(
  start: string | undefined,
  end: string | undefined,
  maxMonths = 12,
): { period: SalonPeriod } | { error: string } {
  const s = parseSalonDay(start);
  const e = parseSalonDay(end);
  if (!s || !e) {
    return {
      error:
        "startDate y endDate deben ser fechas reales con formato AAAA-MM-DD, entre los años 2000 y 2100.",
    };
  }
  if (e < s) return { error: "endDate no puede ser anterior a startDate." };
  const months = Math.max(1, Math.min(12, Math.floor(maxMonths) || 1));
  // 3 months = 92 days, 6 = 183, 12 = 366: never over MAX_PERIOD_DAYS.
  const limit = Math.min(Math.ceil(months * 30.5), MAX_PERIOD_DAYS);
  if (periodLength({ start: s, end: e }) > limit) {
    return {
      error: `El período no puede superar ${months} ${months === 1 ? "mes" : "meses"} (${limit} días) en tu plan.`,
    };
  }
  return { period: { start: s, end: e } };
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export interface AppointmentMoney {
  status: string;
  paymentStatus: string;
  /** Cents charged, VAT included (appointments.amountPaid). */
  amountPaid?: unknown;
  /** The visit's discount record: its loyalty reward's money is `discount.loyalty.moneyCents`. */
  discount?: unknown;
}

/**
 * Revenue counts appointments the salon has actually charged: marked as paid
 * (the till's "cobrar" does that) and not cancelled. A confirmed appointment
 * that nobody has paid yet is not revenue -- it used to be.
 */
export function isPaidAppointment(a: AppointmentMoney): boolean {
  return a.paymentStatus === "paid" && a.status !== "cancelled";
}

/**
 * What an appointment brought in, in cents: what was charged (amountPaid,
 * VAT included, net of partial refunds) and nothing else. It used to fall
 * back on the catalogue total, which excludes VAT when the salon's prices
 * do, so a paid row recorded with amountPaid 0 mixed net into gross figures.
 */
export function appointmentValueCents(a: AppointmentMoney): number {
  const paid = Number(a.amountPaid ?? 0);
  return Number.isFinite(paid) && paid > 0 ? Math.round(paid) : 0;
}

/**
 * What a visit brought in, in cents: money charged, VAT included (what Caja
 * and the invoices show), dated by the visit's day.
 *
 * - A paid visit that was not cancelled: what was charged for it, less what
 *   the client's loyalty reward covered (`discount.loyalty.moneyCents`). The
 *   till adds the reward to amountPaid so the visit reads as paid, but no
 *   money came in for it: Caja has no payment for it and the invoice shows
 *   it as a discount (owner decision D4: points are not revenue).
 * - A visit that will not be charged any more (cancelled, or a no-show)
 *   counts what the salon kept of what was paid for it (a prepayment or a
 *   cancellation fee not given back), less the reward. A refund lowers
 *   amountPaid, so this is net of partial refunds and a full one leaves 0
 *   (owner decision D9, 2a).
 * - Anything else (confirmed, pending, partly paid and still to come) is
 *   not revenue yet.
 */
export function revenueCents(a: AppointmentMoney): number {
  const reward = loyaltyMoneyCents(a.discount);
  if (isPaidAppointment(a)) return Math.max(0, appointmentValueCents(a) - reward);
  if ((a.status === "cancelled" || a.status === "no_show") && a.paymentStatus !== "refunded") {
    return Math.max(0, Math.round(Number(a.amountPaid ?? 0)) - reward);
  }
  return 0;
}

/** The former name of revenueCents. */
export const paidRevenueCents = revenueCents;

/**
 * Percentage change, one decimal. Null when the previous figure is 0, both
 * periods empty included: there is nothing to compare with, and the panel
 * shows "—" instead of a flat "+0 %" for a salon that went from 0 to 2.000 €.
 */
export function percentChange(current: number, previous: number): number | null {
  if (!previous || !Number.isFinite(previous) || !Number.isFinite(current)) return null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// Appointment summaries
// ---------------------------------------------------------------------------

export interface ProfessionalRef {
  id: string;
  firstName: string;
  lastName: string;
  profileImage?: string | null;
}

/** A service row of a visit (appointment_services), as analytics reads it. */
export interface AnalyticsVisitRow {
  id: string;
  serviceId?: string;
  professionalId: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  isParallel: boolean;
  /** active | processing | continuation */
  type?: string | null;
  status?: string | null;
  serviceName?: string | null;
  servicePrice?: unknown;
  serviceDuration?: number | null;
  service?: { name?: string | null; price?: unknown; duration?: number | null; bufferTime?: number | null } | null;
  professional?: ProfessionalRef | null;
}

export interface AnalyticsAppointment extends AppointmentMoney {
  scheduledDate: Date | string;
  /** "HH:MM" on the salon's clock: places a visit's rows for occupancy. */
  scheduledTime?: string | null;
  /** The visit's service rows (multi-service visits); empty or absent for one service. */
  services?: AnalyticsVisitRow[] | null;
  duration?: number | null;
  clientId?: string;
  professionalId?: string | null;
  serviceId?: string | null;
  locationId?: string | null;
  /** The service's name when it was booked (appointment-snapshot.ts). */
  serviceName?: string | null;
  service?: { name: string } | null;
  professional?: {
    id: string;
    firstName: string;
    lastName: string;
    profileImage?: string | null;
  } | null;
}

export interface AppointmentSummary {
  /** revenueCents() of every appointment, in cents. */
  revenue: number;
  /** Appointments booked in the period, cancelled ones excluded. */
  appointments: number;
  paidAppointments: number;
  completedAppointments: number;
  /** revenue / paidAppointments, in cents. */
  avgTicket: number;
}

export function summarize(appointments: ReadonlyArray<AnalyticsAppointment>): AppointmentSummary {
  let revenue = 0;
  let paidRevenue = 0;
  let booked = 0;
  let paid = 0;
  let completed = 0;
  for (const a of appointments) {
    if (a.status !== "cancelled") booked++;
    if (a.status === "completed") completed++;
    const cents = revenueCents(a);
    revenue += cents;
    if (isPaidAppointment(a)) {
      paid++;
      paidRevenue += cents;
    }
  }
  return {
    revenue,
    appointments: booked,
    paidAppointments: paid,
    completedAppointments: completed,
    // The average paid visit: money kept on a cancelled visit is revenue,
    // not a ticket.
    avgTicket: paid > 0 ? Math.round(paidRevenue / paid) : 0,
  };
}

/** One service of a visit, with its share of what the visit brought in. */
export interface VisitPart {
  /** The service's id, else its name. */
  serviceKey: string;
  serviceName: string;
  /** Who did it; the visit's professional when the row names nobody. */
  professional: ProfessionalRef | null;
  revenueCents: number;
}

/**
 * A visit split by service (owner decision D5). A visit with two or more
 * services (live rows of appointment_services; processing time is time, not
 * a service) has its revenue shared over them in proportion to the list
 * price each was booked at, in whole cents that add up; each part goes to
 * its own service and to the professional who did it. All-zero prices
 * share equally. A one-service visit is one part, its service and its
 * professional, as before.
 */
export function visitParts(a: AnalyticsAppointment): VisitPart[] {
  const value = revenueCents(a);
  const rows = (a.services ?? []).filter((r) => isLiveRow(r) && !freesProfessional(r));
  if (rows.length < 2) {
    const name = a.serviceName || a.service?.name || "Sin servicio";
    return [{ serviceKey: a.serviceId || name, serviceName: name, professional: a.professional ?? null, revenueCents: value }];
  }
  const prices = rows.map((r) => toCents(rowService(r)?.price));
  const shares = allocateCents(value, prices.some((p) => p > 0) ? prices : rows.map(() => 1));
  return rows.map((r, i) => {
    const name = rowService(r)?.name || "Sin servicio";
    const professional =
      !r.professionalId || r.professionalId === a.professional?.id
        ? (a.professional ?? null)
        : (r.professional ?? { id: r.professionalId, firstName: "", lastName: "" });
    return { serviceKey: r.serviceId || name, serviceName: name, professional, revenueCents: shares[i] };
  });
}

/**
 * Bookings and revenue per service, by revenue then bookings. Each service
 * of a multi-service visit counts as a booking of its own (visitParts). A
 * cancelled visit books nothing, but the money kept on it still counts.
 */
export function topServices(
  appointments: ReadonlyArray<AnalyticsAppointment>,
  limit = 5,
): { name: string; count: number; revenue: number }[] {
  const by = new Map<string, { name: string; count: number; revenue: number }>();
  for (const a of appointments) {
    const cancelled = a.status === "cancelled";
    for (const part of visitParts(a)) {
      if (cancelled && part.revenueCents === 0) continue;
      const row = by.get(part.serviceKey) ?? { name: part.serviceName, count: 0, revenue: 0 };
      if (!cancelled) row.count++;
      row.revenue += part.revenueCents;
      by.set(part.serviceKey, row);
    }
  }
  return [...by.values()]
    .sort((x, y) => y.revenue - x.revenue || y.count - x.count || x.name.localeCompare(y.name))
    .slice(0, limit);
}

/** Share of bookings per service (cancelled excluded). */
export function servicePopularity(
  appointments: ReadonlyArray<AnalyticsAppointment>,
  limit = 10,
): { name: string; count: number; percentage: number }[] {
  const rows = topServices(appointments, Number.MAX_SAFE_INTEGER).filter((r) => r.count > 0);
  const total = rows.reduce((s, r) => s + r.count, 0);
  return rows
    .map((r) => ({
      name: r.name,
      count: r.count,
      percentage: total > 0 ? Math.round((r.count / total) * 100) : 0,
    }))
    .sort((x, y) => y.count - x.count || x.name.localeCompare(y.name))
    .slice(0, limit);
}

export interface ProfessionalRow {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  profileImage: string | null;
  /** Visits they took part in (one per visit, however many of its services), cancelled ones excluded. */
  appointments: number;
  /** Their share of what appointments brought in (revenueCents, split by visitParts), cents. */
  revenue: number;
  /** Services they did that were sold at the till without an appointment, net of refunds, cents. */
  tillServicesCents: number;
  /** revenue + tillServicesCents: all charged for their work, VAT included, cents. */
  revenueCents: number;
  /** Their appointments with a closed status up to yesterday (closedRates' definition). */
  closedAppointments: number;
  completedAppointments: number;
  cancelledAppointments: number;
  noShowAppointments: number;
  /** Over closedAppointments, percent with one decimal; null with none closed. */
  completionRate: number | null;
  cancellationRate: number | null;
  noShowRate: number | null;
}

/** A service sold at the till without an appointment (a sale line of kind "service"). */
export interface TillServiceLine {
  professionalId: string | null;
  /** What is left of the line after refunds, money cents (VAT included). */
  keptCents: number;
}

/**
 * Per professional: visits, revenue and how their appointments closed.
 *
 * Revenue is "cobrado, IVA incluido" (owner decision D6, 3a): their share of
 * each visit's revenue (revenueCents, split per service by visitParts) plus
 * the services they did that were sold at the till without an appointment
 * (`tillServices`, sale lines of kind "service", what is left after
 * refunds). A visit charged at the till is a sale line of kind
 * "appointment", never "service", so it is counted once, from the
 * appointment. Comisiones counts the commission base instead (catalogue
 * price, completed visits only), so the two figures need not match.
 *
 * The closing counts follow closedRates: appointments with a closed status
 * (completed, cancelled, no-show) up to the day before `today` (every day
 * of the rows when it is not given). A visit counts for each professional
 * who took part in it.
 *
 * `directory` names the professionals who appear only through the till.
 */
export function topProfessionals(
  appointments: ReadonlyArray<AnalyticsAppointment>,
  limit = 5,
  opts: {
    today?: string;
    tillServices?: ReadonlyArray<TillServiceLine>;
    directory?: ReadonlyMap<string, ProfessionalRef>;
  } = {},
): ProfessionalRow[] {
  const through = opts.today ? addDays(opts.today, -1) : null;
  const by = new Map<string, ProfessionalRow>();
  const rowOf = (p: ProfessionalRef): ProfessionalRow => {
    let row = by.get(p.id);
    if (!row) {
      row = {
        id: p.id,
        name: `${p.firstName} ${p.lastName}`.trim(),
        firstName: p.firstName,
        lastName: p.lastName,
        profileImage: p.profileImage ?? null,
        appointments: 0,
        revenue: 0,
        tillServicesCents: 0,
        revenueCents: 0,
        closedAppointments: 0,
        completedAppointments: 0,
        cancelledAppointments: 0,
        noShowAppointments: 0,
        completionRate: null,
        cancellationRate: null,
        noShowRate: null,
      };
      by.set(p.id, row);
    }
    return row;
  };
  for (const a of appointments) {
    const took = new Map<string, ProfessionalRef>();
    for (const part of visitParts(a)) {
      if (!part.professional) continue;
      took.set(part.professional.id, part.professional);
      if (part.revenueCents > 0) rowOf(part.professional).revenue += part.revenueCents;
    }
    const closed = isClosedStatus(a.status) && (!through || appointmentDay(a.scheduledDate) <= through);
    for (const p of took.values()) {
      if (a.status !== "cancelled") rowOf(p).appointments++;
      if (!closed) continue;
      const row = rowOf(p);
      row.closedAppointments++;
      if (a.status === "completed") row.completedAppointments++;
      else if (a.status === "cancelled") row.cancelledAppointments++;
      else row.noShowAppointments++;
    }
  }
  for (const line of opts.tillServices ?? []) {
    if (!line.professionalId || line.keptCents <= 0) continue;
    const known = by.get(line.professionalId) ?? opts.directory?.get(line.professionalId);
    if (known) rowOf(known).tillServicesCents += line.keptCents;
  }
  const rows = [...by.values()];
  for (const r of rows) {
    r.revenueCents = r.revenue + r.tillServicesCents;
    r.completionRate = rate(r.completedAppointments, r.closedAppointments);
    r.cancellationRate = rate(r.cancelledAppointments, r.closedAppointments);
    r.noShowRate = rate(r.noShowAppointments, r.closedAppointments);
  }
  return rows
    .sort((x, y) => y.revenueCents - x.revenueCents || y.appointments - x.appointments)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Closing rates
// ---------------------------------------------------------------------------

/** The statuses an appointment ends in. */
export const CLOSED_STATUSES = ["completed", "cancelled", "no_show"] as const;

export function isClosedStatus(status: string): boolean {
  return (CLOSED_STATUSES as readonly string[]).includes(status);
}

/** part / whole as a percentage with one decimal; null when whole is 0. */
function rate(part: number, whole: number): number | null {
  return whole > 0 ? Math.round((part / whole) * 1000) / 10 : null;
}

export interface AppointmentRates {
  /** The last day counted: the day before the salon's today. */
  through: string;
  /** Appointments up to `through` with a closed status: completed, cancelled or no-show. */
  closed: number;
  completed: number;
  cancelled: number;
  noShow: number;
  /** Over `closed`, percent with one decimal; null when nothing closed. */
  completionRate: number | null;
  cancellationRate: number | null;
  noShowRate: number | null;
}

/**
 * The one definition of the completion, cancellation and no-show rates
 * (U9): over the appointments that have closed (completed, cancelled or
 * no-show) scheduled up to yesterday on the salon's calendar. Today's
 * appointments are left out, and so are confirmed and pending ones (still
 * open), so a rate does not dip during the day while visits are under way.
 */
export function closedRates(
  rows: ReadonlyArray<{ status: string; scheduledDate: Date | string }>,
  today: string,
): AppointmentRates {
  const through = addDays(today, -1);
  let completed = 0;
  let cancelled = 0;
  let noShow = 0;
  for (const r of rows) {
    if (appointmentDay(r.scheduledDate) > through) continue;
    if (r.status === "completed") completed++;
    else if (r.status === "cancelled") cancelled++;
    else if (r.status === "no_show") noShow++;
  }
  const closed = completed + cancelled + noShow;
  return {
    through,
    closed,
    completed,
    cancelled,
    noShow,
    completionRate: rate(completed, closed),
    cancellationRate: rate(cancelled, closed),
    noShowRate: rate(noShow, closed),
  };
}

/** closedRates for each calendar month of the period, months as "YYYY-MM". */
export function monthlyClosedRates(
  rows: ReadonlyArray<{ status: string; scheduledDate: Date | string }>,
  period: SalonPeriod,
  today: string,
): Array<{ month: string } & AppointmentRates> {
  const months = new Map<string, Array<{ status: string; scheduledDate: Date | string }>>();
  for (let m = monthStart(period.start); m <= period.end; m = monthStart(m, 1)) months.set(m.slice(0, 7), []);
  for (const r of rows) months.get(appointmentDay(r.scheduledDate).slice(0, 7))?.push(r);
  return [...months.entries()].map(([month, list]) => ({ month, ...closedRates(list, today) }));
}

/** One row per day of the period, empty days included. */
export function dailyMetrics(
  appointments: ReadonlyArray<AnalyticsAppointment>,
  period: SalonPeriod,
): { date: string; appointments: number; revenue: number }[] {
  const rows = new Map(daysIn(period).map((d) => [d, { date: d, appointments: 0, revenue: 0 }]));
  for (const a of appointments) {
    const row = rows.get(appointmentDay(a.scheduledDate));
    if (!row) continue;
    if (a.status !== "cancelled") row.appointments++;
    row.revenue += revenueCents(a);
  }
  return [...rows.values()];
}

/** Revenue per calendar month of the period, as "YYYY-MM". */
export function monthlyRevenue(
  appointments: ReadonlyArray<AnalyticsAppointment>,
  period: SalonPeriod,
): { month: string; revenue: number }[] {
  const rows = new Map<string, { month: string; revenue: number }>();
  for (let m = monthStart(period.start); m <= period.end; m = monthStart(m, 1)) {
    rows.set(m.slice(0, 7), { month: m.slice(0, 7), revenue: 0 });
  }
  for (const a of appointments) {
    const row = rows.get(appointmentDay(a.scheduledDate).slice(0, 7));
    if (row) row.revenue += revenueCents(a);
  }
  return [...rows.values()];
}

export const STATUS_ORDER = [
  "completed",
  "confirmed",
  "pending",
  "in_progress",
  "cancelled",
  "no_show",
] as const;

export const STATUS_DISPLAY: Record<string, string> = {
  completed: "Completed",
  confirmed: "Confirmed",
  pending: "Pending",
  cancelled: "Cancelled",
  no_show: "No Show",
  in_progress: "In Progress",
};

/** Per-status counts for every calendar month of the period. */
export function monthlyStatusCounts(
  rows: ReadonlyArray<{ status: string; scheduledDate: Date | string }>,
  period: SalonPeriod,
): Array<{ period: string } & Record<string, number | string>> {
  const months = new Map<string, Record<string, number>>();
  for (let m = monthStart(period.start); m <= period.end; m = monthStart(m, 1)) {
    months.set(
      m.slice(0, 7),
      Object.fromEntries(STATUS_ORDER.map((s) => [STATUS_DISPLAY[s], 0])),
    );
  }
  for (const r of rows) {
    const bucket = months.get(appointmentDay(r.scheduledDate).slice(0, 7));
    const name = STATUS_DISPLAY[r.status];
    if (bucket && name) bucket[name]++;
  }
  return [...months.entries()].map(([period, counts]) => ({ period, ...counts }));
}

// ---------------------------------------------------------------------------
// Recurring clients
// ---------------------------------------------------------------------------

/**
 * A recurring client ("clienta recurrente") is one served in the period -- at
 * least one completed appointment in it -- who either came back within the
 * period (two or more completed appointments) or had already been served
 * before the period began. The retention rate is recurring clients over all
 * clients served in the period.
 *
 * `periodCompletedClientIds` has one entry per completed appointment in the
 * period; `servedBefore` holds the clients with a completed appointment
 * before the period's first day.
 */
export function clientRetention(
  periodCompletedClientIds: ReadonlyArray<string>,
  servedBefore: ReadonlySet<string>,
): { clientsServed: number; returningClients: number; retentionRate: number } {
  const visits = new Map<string, number>();
  for (const id of periodCompletedClientIds) visits.set(id, (visits.get(id) ?? 0) + 1);
  let returning = 0;
  for (const [id, n] of visits) {
    if (n >= 2 || servedBefore.has(id)) returning++;
  }
  const served = visits.size;
  return {
    clientsServed: served,
    returningClients: returning,
    retentionRate: served > 0 ? Math.round((returning / served) * 100) : 0,
  };
}

/**
 * New clients ("clientas nuevas", owner decision D7, 1a): clients whose FIRST
 * completed visit falls in the period. `periodCompletedClientIds` are the
 * clients of the period's completed appointments, `servedBefore` those with a
 * completed appointment before the period's first day. A client record
 * created in the period (an import, a contact, a booking that never
 * happened) is not a new client until she comes.
 */
export function newClientCount(
  periodCompletedClientIds: Iterable<string>,
  servedBefore: ReadonlySet<string>,
): number {
  let n = 0;
  for (const id of new Set(periodCompletedClientIds)) if (!servedBefore.has(id)) n++;
  return n;
}

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------

export interface Occupancy {
  /** Minutes of non-cancelled appointments of professionals with a schedule. */
  bookedMinutes: number;
  /** Minutes those professionals work in the period, per their schedule, less approved time off. */
  availableMinutes: number;
  /** booked / available, as a percentage with one decimal; null when nobody has a schedule. */
  rate: number | null;
  /** Professionals counted (those with working hours recorded). */
  professionalsWithSchedule: number;
}

export interface OccupancyAppointment {
  professionalId?: string | null;
  duration?: number | null;
  status: string;
  scheduledDate: Date | string;
  scheduledTime?: string | null;
  services?: AnalyticsVisitRow[] | null;
}

/**
 * Minutes each professional spends on a visit. One service: its
 * professional, for its duration. Several (D5): each professional during
 * their own services, nobody during processing time, and the visit's
 * professional for whatever of its duration runs past them (add-ons): the
 * agenda's own reading (appointmentBusyBlocks), without the cleanup after
 * the visit.
 */
export function busyMinutes(a: OccupancyAppointment, timeZone: string): Map<string, number> {
  const out = new Map<string, number>();
  const duration = Math.max(0, Number(a.duration ?? 0));
  const live = (a.services ?? []).filter(isLiveRow);
  const blocks =
    live.length > 0 && a.professionalId && a.scheduledTime
      ? appointmentBusyBlocks(
          {
            professionalId: a.professionalId,
            scheduledDate: a.scheduledDate,
            scheduledTime: a.scheduledTime,
            duration,
            services: live,
          },
          timeZone,
        ).filter((b) => !b.cleanup)
      : [];
  if (blocks.length === 0) {
    if (a.professionalId) out.set(a.professionalId, duration);
    return out;
  }
  for (const b of blocks) {
    out.set(b.professionalId, (out.get(b.professionalId) ?? 0) + Math.max(0, b.endMinutes - b.startMinutes));
  }
  return out;
}

/**
 * Occupancy is booked time over working time. Working time comes from each
 * professional's weekly hours (`professionals.workingHours`) over the days of
 * the period; booked time is the duration of their appointments in it,
 * cancelled ones excluded (a no-show still held the slot), each professional
 * of a multi-service visit for their own part of it (busyMinutes). Professionals with
 * no hours recorded are left out on both sides rather than assumed to work
 * some default shift -- if none has hours, the rate is null and the panel says
 * the schedules are missing.
 *
 * Approved time off is taken out of working time: the salon's closures and
 * each professional's own absences, whole days and stretches of hours alike,
 * read the way availability reads them (dayBlocks, availableWindows). A
 * stylist on holiday is not free time nobody sold. `timeOff` is the salon's
 * approved blocks touching the period (timeOffBetween); others are ignored.
 */
export function occupancy(
  professionals: ReadonlyArray<{ id: string; workingHours?: unknown }>,
  appointments: ReadonlyArray<OccupancyAppointment>,
  period: SalonPeriod,
  timeOff: ReadonlyArray<TimeOffBlock> = [],
  timeZone = "Europe/Madrid",
): Occupancy {
  const days = daysIn(period);
  const counted = new Set<string>();
  let available = 0;
  for (const p of professionals) {
    let minutes = 0;
    let hasSchedule = false;
    for (const day of days) {
      const shifts = workingWindowsFor(p.workingHours, toUtcDate(day));
      if (shifts === undefined) break; // nothing recorded for this professional
      hasSchedule = true;
      // Every shift of the day, not the first: a 10:00–14:00 + 17:00–20:00
      // day is 7 hours of capacity, and the lunch gap is not part of it.
      // With shifts recorded, availableWindows is never undefined.
      const open = availableWindows(shifts, dayBlocks(timeOff, day, p.id)) ?? [];
      for (const s of open) minutes += s.endMinutes - s.startMinutes;
    }
    if (hasSchedule) {
      counted.add(p.id);
      available += minutes;
    }
  }
  let booked = 0;
  for (const a of appointments) {
    if (a.status === "cancelled") continue;
    const day = appointmentDay(a.scheduledDate);
    if (day < period.start || day > period.end) continue;
    for (const [professionalId, minutes] of busyMinutes(a, timeZone)) {
      if (counted.has(professionalId)) booked += minutes;
    }
  }
  return {
    bookedMinutes: booked,
    availableMinutes: available,
    rate: available > 0 ? Math.round((booked / available) * 1000) / 10 : null,
    professionalsWithSchedule: counted.size,
  };
}
