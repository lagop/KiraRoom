/**
 * The analytics screens showed figures that were not measured: "clientas
 * recurrentes" was 40 % of the appointment count, revenue included confirmed
 * appointments nobody had paid, months were cut on the server's UTC clock and
 * "vs last month" set six months against one. These tests pin each
 * definition with fixed data so the numbers can only come from the rows.
 */
import {
  AnalyticsAppointment,
  appointmentValueCents,
  clientRetention,
  dailyMetrics,
  explicitPeriod,
  instantRange,
  lastMonthsPeriod,
  monthlyRevenue,
  monthlyStatusCounts,
  occupancy,
  percentChange,
  previousPeriod,
  rangePeriod,
  salonToday,
  scheduledDateRange,
  servicePopularity,
  shiftMonths,
  summarize,
  topProfessionals,
  topServices,
} from "./analytics-metrics";

const apt = (over: Partial<AnalyticsAppointment>): AnalyticsAppointment => ({
  status: "completed",
  paymentStatus: "paid",
  amountPaid: 0,
  totalAmount: 0,
  price: 0,
  scheduledDate: new Date("2026-10-01T00:00:00.000Z"),
  duration: 60,
  ...over,
});

describe("periods follow the salon's calendar", () => {
  it("today is the salon's date, not the server's", () => {
    // 23:30 UTC on 30 September is already 1 October in Madrid (UTC+2)...
    expect(salonToday("Europe/Madrid", new Date("2026-09-30T22:30:00Z"))).toBe("2026-10-01");
    // ...and still 30 September in the Canaries (UTC+1).
    expect(salonToday("Atlantic/Canary", new Date("2026-09-30T22:30:00Z"))).toBe("2026-09-30");
  });

  it("months=1 is this month so far; months=3 adds the two previous months", () => {
    expect(lastMonthsPeriod("2026-10-02", 1)).toEqual({ start: "2026-10-01", end: "2026-10-02" });
    expect(lastMonthsPeriod("2026-10-02", 3)).toEqual({ start: "2026-08-01", end: "2026-10-02" });
    expect(lastMonthsPeriod("2026-01-15", 2)).toEqual({ start: "2025-12-01", end: "2026-01-15" });
  });

  it("compares a started month with the same days of the month before", () => {
    expect(previousPeriod({ start: "2026-10-01", end: "2026-10-02" }, 1)).toEqual({
      start: "2026-09-01",
      end: "2026-09-02",
    });
    // 31 March minus a month is the last day of February.
    expect(shiftMonths("2026-03-31", -1)).toBe("2026-02-28");
    // Without months: the equally long run of days just before.
    expect(previousPeriod({ start: "2026-09-28", end: "2026-10-04" })).toEqual({
      start: "2026-09-21",
      end: "2026-09-27",
    });
  });

  it("names ranges in salon days, weeks starting on Monday", () => {
    const today = "2026-10-02"; // a Friday
    expect(rangePeriod("today", today)).toEqual({ start: today, end: today });
    expect(rangePeriod("this_week", today)).toEqual({ start: "2026-09-28", end: today });
    expect(rangePeriod("last_week", today)).toEqual({ start: "2026-09-21", end: "2026-09-27" });
    expect(rangePeriod("last_month", today)).toEqual({ start: "2026-09-01", end: "2026-09-30" });
    expect(rangePeriod("last_30_days", today)).toEqual({ start: "2026-09-03", end: today });
    expect(rangePeriod("6_months", today)).toEqual({ start: "2026-05-01", end: today });
    // The plan's history limit cuts a longer range.
    expect(rangePeriod("12_months", today, 3)).toEqual({ start: "2026-08-01", end: today });
    expect(rangePeriod(undefined, today)).toEqual({ start: "2026-10-01", end: today });
  });

  it("filters calendar days on scheduledDate and salon midnights on instants", () => {
    const p = { start: "2026-10-01", end: "2026-10-31" };
    expect(scheduledDateRange(p)).toEqual({
      gte: new Date("2026-10-01T00:00:00.000Z"),
      lt: new Date("2026-11-01T00:00:00.000Z"),
    });
    // Madrid: UTC+2 on 1 October, UTC+1 on 1 November (after DST ends).
    expect(instantRange(p, "Europe/Madrid")).toEqual({
      gte: new Date("2026-09-30T22:00:00.000Z"),
      lt: new Date("2026-10-31T23:00:00.000Z"),
    });
  });

  it("accepts explicit YYYY-MM-DD dates only", () => {
    expect(explicitPeriod("2026-10-05", "2026-10-01")).toEqual({ start: "2026-10-01", end: "2026-10-05" });
    expect(explicitPeriod("ayer", "2026-10-01")).toBeNull();
    expect(explicitPeriod(undefined, "2026-10-01")).toBeNull();
  });
});

describe("revenue counts what was charged", () => {
  it("values an appointment in cents: charged, else total, else list price", () => {
    expect(appointmentValueCents(apt({ amountPaid: 3000, totalAmount: 3500, price: 35 }))).toBe(3000);
    expect(appointmentValueCents(apt({ totalAmount: 3500, price: 35 }))).toBe(3500);
    expect(appointmentValueCents(apt({ price: "35.50" }))).toBe(3550);
  });

  it("leaves out unpaid and cancelled appointments", () => {
    const s = summarize([
      apt({ totalAmount: 4000 }), // paid, completed
      apt({ status: "confirmed", paymentStatus: "pending", totalAmount: 9900 }), // not paid yet
      apt({ status: "cancelled", paymentStatus: "paid", totalAmount: 5000 }), // cancelled
      apt({ status: "confirmed", paymentStatus: "paid", amountPaid: 2000 }), // paid in advance
    ]);
    expect(s.revenue).toBe(6000);
    expect(s.paidAppointments).toBe(2);
    expect(s.appointments).toBe(3); // cancelled excluded
    expect(s.completedAppointments).toBe(1);
    expect(s.avgTicket).toBe(3000);
  });

  it("reports changes against a real previous figure only", () => {
    expect(percentChange(150, 100)).toBe(50);
    expect(percentChange(1, 3)).toBe(-66.7);
    expect(percentChange(10, 0)).toBe(0);
  });

  it("breaks revenue down by service, professional, day and month", () => {
    const ana = { id: "p1", firstName: "Ana", lastName: "Ruiz", profileImage: null };
    const eva = { id: "p2", firstName: "Eva", lastName: "Gil", profileImage: null };
    const rows = [
      apt({ serviceId: "s1", service: { name: "Corte" }, professional: ana, totalAmount: 2000, scheduledDate: new Date("2026-09-30T00:00:00Z") }),
      apt({ serviceId: "s1", service: { name: "Corte" }, professional: eva, totalAmount: 2000, scheduledDate: new Date("2026-10-01T00:00:00Z") }),
      apt({ serviceId: "s2", service: { name: "Color" }, professional: ana, totalAmount: 6000, scheduledDate: new Date("2026-10-01T00:00:00Z") }),
      apt({ serviceId: "s1", service: { name: "Corte" }, professional: eva, status: "confirmed", paymentStatus: "pending", totalAmount: 2000, scheduledDate: new Date("2026-10-02T00:00:00Z") }),
    ];
    expect(topServices(rows)).toEqual([
      { name: "Color", count: 1, revenue: 6000 },
      { name: "Corte", count: 3, revenue: 4000 },
    ]);
    expect(servicePopularity(rows)).toEqual([
      { name: "Corte", count: 3, percentage: 75 },
      { name: "Color", count: 1, percentage: 25 },
    ]);
    expect(topProfessionals(rows).map((p) => [p.name, p.appointments, p.revenue])).toEqual([
      ["Ana Ruiz", 2, 8000],
      ["Eva Gil", 2, 2000],
    ]);
    expect(dailyMetrics(rows, { start: "2026-10-01", end: "2026-10-03" })).toEqual([
      { date: "2026-10-01", appointments: 2, revenue: 8000 },
      { date: "2026-10-02", appointments: 1, revenue: 0 },
      { date: "2026-10-03", appointments: 0, revenue: 0 },
    ]);
    expect(monthlyRevenue(rows, { start: "2026-09-01", end: "2026-10-02" })).toEqual([
      { month: "2026-09", revenue: 2000 },
      { month: "2026-10", revenue: 8000 },
    ]);
  });

  it("counts statuses per month", () => {
    const evolution = monthlyStatusCounts(
      [
        { status: "completed", scheduledDate: new Date("2026-09-10T00:00:00Z") },
        { status: "cancelled", scheduledDate: new Date("2026-10-01T00:00:00Z") },
        { status: "no_show", scheduledDate: new Date("2026-10-02T00:00:00Z") },
      ],
      { start: "2026-09-01", end: "2026-10-02" },
    );
    expect(evolution.map((m) => [m.period, m.Completed, m.Cancelled, m["No Show"]])).toEqual([
      ["2026-09", 1, 0, 0],
      ["2026-10", 0, 1, 1],
    ]);
  });
});

describe("recurring clients", () => {
  it("are served in the period and came back in it or had come before", () => {
    // a: two visits in the period -> recurring
    // b: one visit, never before   -> new
    // c: one visit, served before  -> recurring
    // d: served before, not in the period -> not counted at all
    const r = clientRetention(["a", "a", "b", "c"], new Set(["c", "d"]));
    expect(r).toEqual({ clientsServed: 3, returningClients: 2, retentionRate: 67 });
  });

  it("is zero, not an estimate, when nobody was served", () => {
    expect(clientRetention([], new Set(["x"]))).toEqual({
      clientsServed: 0,
      returningClients: 0,
      retentionRate: 0,
    });
  });
});

describe("occupancy", () => {
  const week = { start: "2026-09-28", end: "2026-10-02" }; // Monday to Friday

  it("is booked minutes over scheduled working minutes", () => {
    const professionals = [
      {
        id: "p1",
        workingHours: [
          { day: "monday", openTime: "09:00", closeTime: "17:00" }, // 480
          { day: "friday", openTime: "10:00", closeTime: "14:00" }, // 240
        ],
      },
      { id: "p2", workingHours: [] }, // no schedule recorded
    ];
    const result = occupancy(
      professionals,
      [
        { professionalId: "p1", duration: 60, status: "completed", scheduledDate: "2026-09-28" },
        { professionalId: "p1", duration: 90, status: "confirmed", scheduledDate: "2026-10-02" },
        { professionalId: "p1", duration: 30, status: "cancelled", scheduledDate: "2026-10-02" },
        { professionalId: "p2", duration: 60, status: "completed", scheduledDate: "2026-09-29" },
        { professionalId: "p1", duration: 60, status: "completed", scheduledDate: "2026-10-05" }, // outside
      ],
      week,
    );
    expect(result).toEqual({
      bookedMinutes: 150,
      availableMinutes: 720,
      rate: 20.8,
      professionalsWithSchedule: 1,
    });
  });

  it("is null when no professional has working hours", () => {
    expect(occupancy([{ id: "p1", workingHours: [] }], [], week).rate).toBeNull();
  });
});
