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
import { workingWindowFor } from "../appointments/working-hours";

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

export function daysIn(period: SalonPeriod): string[] {
  const days: string[] = [];
  for (let d = period.start; d <= period.end; d = addDays(d, 1)) days.push(d);
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

/** Parses an explicit "YYYY-MM-DD" pair; null when either side is not a date. */
export function explicitPeriod(start?: string, end?: string): SalonPeriod | null {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const s = start?.slice(0, 10);
  const e = end?.slice(0, 10);
  if (!s || !e || !re.test(s) || !re.test(e)) return null;
  if (Number.isNaN(toUtcDate(s).getTime()) || Number.isNaN(toUtcDate(e).getTime())) return null;
  return s <= e ? { start: s, end: e } : { start: e, end: s };
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

export interface AppointmentMoney {
  status: string;
  paymentStatus: string;
  amountPaid?: unknown;
  totalAmount?: unknown;
  price?: unknown;
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
 * What an appointment brought in, in cents: what was charged when recorded,
 * else its total (cents), else its list price (euros, hence × 100).
 */
export function appointmentValueCents(a: AppointmentMoney): number {
  const paid = Number(a.amountPaid ?? 0);
  if (paid > 0) return Math.round(paid);
  const total = Number(a.totalAmount ?? 0);
  if (total > 0) return Math.round(total);
  return Math.round(Number(a.price ?? 0) * 100);
}

export function paidRevenueCents(a: AppointmentMoney): number {
  return isPaidAppointment(a) ? appointmentValueCents(a) : 0;
}

/** Percentage change, one decimal; 0 when there is nothing to compare with. */
export function percentChange(current: number, previous: number): number {
  if (!previous) return 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

// ---------------------------------------------------------------------------
// Appointment summaries
// ---------------------------------------------------------------------------

export interface AnalyticsAppointment extends AppointmentMoney {
  scheduledDate: Date | string;
  duration?: number | null;
  clientId?: string;
  professionalId?: string | null;
  serviceId?: string | null;
  locationId?: string | null;
  service?: { name: string } | null;
  professional?: {
    id: string;
    firstName: string;
    lastName: string;
    profileImage?: string | null;
  } | null;
}

export interface AppointmentSummary {
  /** Paid, non-cancelled appointments, in cents. */
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
  let booked = 0;
  let paid = 0;
  let completed = 0;
  for (const a of appointments) {
    if (a.status !== "cancelled") booked++;
    if (a.status === "completed") completed++;
    if (isPaidAppointment(a)) {
      paid++;
      revenue += appointmentValueCents(a);
    }
  }
  return {
    revenue,
    appointments: booked,
    paidAppointments: paid,
    completedAppointments: completed,
    avgTicket: paid > 0 ? Math.round(revenue / paid) : 0,
  };
}

/** Bookings and revenue per service, by revenue then bookings. */
export function topServices(
  appointments: ReadonlyArray<AnalyticsAppointment>,
  limit = 5,
): { name: string; count: number; revenue: number }[] {
  const by = new Map<string, { name: string; count: number; revenue: number }>();
  for (const a of appointments) {
    if (a.status === "cancelled") continue;
    const name = a.service?.name || "Sin servicio";
    const key = a.serviceId || name;
    const row = by.get(key) ?? { name, count: 0, revenue: 0 };
    row.count++;
    row.revenue += paidRevenueCents(a);
    by.set(key, row);
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
  const rows = topServices(appointments, Number.MAX_SAFE_INTEGER);
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
  appointments: number;
  revenue: number;
}

export function topProfessionals(
  appointments: ReadonlyArray<AnalyticsAppointment>,
  limit = 5,
): ProfessionalRow[] {
  const by = new Map<string, ProfessionalRow>();
  for (const a of appointments) {
    const p = a.professional;
    if (!p || a.status === "cancelled") continue;
    const row =
      by.get(p.id) ??
      ({
        id: p.id,
        name: `${p.firstName} ${p.lastName}`.trim(),
        firstName: p.firstName,
        lastName: p.lastName,
        profileImage: p.profileImage ?? null,
        appointments: 0,
        revenue: 0,
      } as ProfessionalRow);
    row.appointments++;
    row.revenue += paidRevenueCents(a);
    by.set(p.id, row);
  }
  return [...by.values()]
    .sort((x, y) => y.revenue - x.revenue || y.appointments - x.appointments)
    .slice(0, limit);
}

/** One row per day of the period, empty days included. */
export function dailyMetrics(
  appointments: ReadonlyArray<AnalyticsAppointment>,
  period: SalonPeriod,
): { date: string; appointments: number; revenue: number }[] {
  const rows = new Map(daysIn(period).map((d) => [d, { date: d, appointments: 0, revenue: 0 }]));
  for (const a of appointments) {
    const row = rows.get(appointmentDay(a.scheduledDate));
    if (!row || a.status === "cancelled") continue;
    row.appointments++;
    row.revenue += paidRevenueCents(a);
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
    if (row) row.revenue += paidRevenueCents(a);
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

// ---------------------------------------------------------------------------
// Occupancy
// ---------------------------------------------------------------------------

export interface Occupancy {
  /** Minutes of non-cancelled appointments of professionals with a schedule. */
  bookedMinutes: number;
  /** Minutes those professionals work in the period, per their schedule. */
  availableMinutes: number;
  /** booked / available, as a percentage with one decimal; null when nobody has a schedule. */
  rate: number | null;
  /** Professionals counted (those with working hours recorded). */
  professionalsWithSchedule: number;
}

/**
 * Occupancy is booked time over working time. Working time comes from each
 * professional's weekly hours (`professionals.workingHours`) over the days of
 * the period; booked time is the duration of their appointments in it,
 * cancelled ones excluded (a no-show still held the slot). Professionals with
 * no hours recorded are left out on both sides rather than assumed to work
 * some default shift -- if none has hours, the rate is null and the panel says
 * the schedules are missing.
 */
export function occupancy(
  professionals: ReadonlyArray<{ id: string; workingHours?: unknown }>,
  appointments: ReadonlyArray<{
    professionalId?: string | null;
    duration?: number | null;
    status: string;
    scheduledDate: Date | string;
  }>,
  period: SalonPeriod,
): Occupancy {
  const days = daysIn(period);
  const counted = new Set<string>();
  let available = 0;
  for (const p of professionals) {
    let minutes = 0;
    let hasSchedule = false;
    for (const day of days) {
      const window = workingWindowFor(p.workingHours, toUtcDate(day));
      if (window === undefined) break; // nothing recorded for this professional
      hasSchedule = true;
      if (window) minutes += window.endMinutes - window.startMinutes;
    }
    if (hasSchedule) {
      counted.add(p.id);
      available += minutes;
    }
  }
  let booked = 0;
  for (const a of appointments) {
    if (a.status === "cancelled" || !a.professionalId || !counted.has(a.professionalId)) continue;
    const day = appointmentDay(a.scheduledDate);
    if (day < period.start || day > period.end) continue;
    booked += Math.max(0, Number(a.duration ?? 0));
  }
  return {
    bookedMinutes: booked,
    availableMinutes: available,
    rate: available > 0 ? Math.round((booked / available) * 1000) / 10 : null,
    professionalsWithSchedule: counted.size,
  };
}
