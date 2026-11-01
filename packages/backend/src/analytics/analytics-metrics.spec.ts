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
  daysIn,
  explicitPeriod,
  instantRange,
  lastMonthsPeriod,
  monthlyRevenue,
  monthlyStatusCounts,
  occupancy,
  parseSalonDay,
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

  it("accepts explicit periods of real days, in order, within the plan", () => {
    expect(explicitPeriod("2026-10-01", "2026-10-05")).toEqual({
      period: { start: "2026-10-01", end: "2026-10-05" },
    });
    // 2024 is a leap year: 29 February exists.
    expect(explicitPeriod("2024-02-29", "2024-03-01")).toHaveProperty("period");
  });

  it("rejects dates that are not real days, or outside 2000-2100", () => {
    for (const [start, end] of [
      ["ayer", "2026-10-01"],
      [undefined, "2026-10-01"],
      ["2026-02-31", "2026-03-01"], // Date would read it as 3 March
      ["2025-02-29", "2025-03-01"], // not a leap year
      ["2026-13-01", "2026-12-31"],
      ["2026-10-01T00:00", "2026-10-02"],
      ["9999-12-31", "9999-12-31"], // the request that froze the server
      ["1900-01-01", "1900-01-02"],
      ["2101-01-01", "2101-01-02"],
    ]) {
      expect(explicitPeriod(start, end)).toEqual({ error: expect.stringContaining("AAAA-MM-DD") });
    }
  });

  it("rejects an end before the start instead of swapping them", () => {
    expect(explicitPeriod("2026-10-05", "2026-10-01")).toEqual({
      error: "endDate no puede ser anterior a startDate.",
    });
  });

  it("caps the length at the plan's months, never over 366 days", () => {
    // Esencial (3 months) = 92 days.
    expect(explicitPeriod("2026-01-01", "2026-04-02", 3)).toHaveProperty("period");
    expect(explicitPeriod("2026-01-01", "2026-04-03", 3)).toEqual({
      error: "El período no puede superar 3 meses (92 días) en tu plan.",
    });
    // Empresa (12) = 366 days; a larger number of months is cut to 12.
    expect(explicitPeriod("2024-01-01", "2024-12-31", 12)).toHaveProperty("period");
    expect(explicitPeriod("2026-01-01", "2027-01-02", 12)).toHaveProperty("error");
    expect(explicitPeriod("2026-01-01", "2027-01-02", 600)).toHaveProperty("error");
  });

  it("parseSalonDay round-trips the day", () => {
    expect(parseSalonDay("2026-11-01")).toBe("2026-11-01");
    expect(parseSalonDay("2026-04-31")).toBeNull();
    expect(parseSalonDay(null)).toBeNull();
  });

  it("daysIn counts the days and refuses runaway periods instead of looping", () => {
    expect(daysIn({ start: "2026-02-27", end: "2026-03-02" })).toEqual([
      "2026-02-27",
      "2026-02-28",
      "2026-03-01",
      "2026-03-02",
    ]);
    expect(daysIn({ start: "2026-10-02", end: "2026-10-01" })).toEqual([]);
    expect(daysIn({ start: "2025-11-01", end: "2026-11-01" })).toHaveLength(366);
    // Past 9999-12-31 the old string loop never ended; now it is one day.
    expect(daysIn({ start: "9999-12-31", end: "9999-12-31" })).toHaveLength(1);
    expect(() => daysIn({ start: "2000-01-01", end: "2026-10-01" })).toThrow(/too long/);
    expect(() => daysIn({ start: "garbage", end: "2026-10-01" })).toThrow(/too long/);
  });
});

describe("revenue counts what was charged", () => {
  it("values a paid appointment at what was charged, VAT included, and nothing else", () => {
    expect(appointmentValueCents(apt({ amountPaid: 3000 }))).toBe(3000);
    expect(appointmentValueCents(apt({ amountPaid: "1234.4" }))).toBe(1234);
    // Paid with amountPaid 0 (PATCH .../payment): no fallback to the
    // catalogue total, which excludes VAT when the salon's prices do.
    const row = { ...apt({ amountPaid: 0 }), totalAmount: 3500, price: 35 };
    expect(appointmentValueCents(row)).toBe(0);
    expect(summarize([row]).revenue).toBe(0);
  });

  it("leaves out unpaid and cancelled appointments", () => {
    const s = summarize([
      apt({ amountPaid: 4000 }), // paid, completed
      apt({ status: "confirmed", paymentStatus: "pending" }), // not paid yet
      apt({ status: "cancelled", paymentStatus: "paid", amountPaid: 5000 }), // cancelled
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
    // Nothing to compare with: null, shown as "—", never a flat +0 %.
    expect(percentChange(10, 0)).toBeNull();
    expect(percentChange(0, 0)).toBeNull();
    expect(percentChange(0, 10)).toBe(-100);
  });

  it("breaks revenue down by service, professional, day and month", () => {
    const ana = { id: "p1", firstName: "Ana", lastName: "Ruiz", profileImage: null };
    const eva = { id: "p2", firstName: "Eva", lastName: "Gil", profileImage: null };
    const rows = [
      apt({ serviceId: "s1", service: { name: "Corte" }, professional: ana, amountPaid: 2000, scheduledDate: new Date("2026-09-30T00:00:00Z") }),
      apt({ serviceId: "s1", service: { name: "Corte" }, professional: eva, amountPaid: 2000, scheduledDate: new Date("2026-10-01T00:00:00Z") }),
      apt({ serviceId: "s2", service: { name: "Color" }, professional: ana, amountPaid: 6000, scheduledDate: new Date("2026-10-01T00:00:00Z") }),
      apt({ serviceId: "s1", service: { name: "Corte" }, professional: eva, status: "confirmed", paymentStatus: "pending", scheduledDate: new Date("2026-10-02T00:00:00Z") }),
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

  it("counts every shift of a split day, and not the gap between them", () => {
    // 10:00–14:00 + 17:00–20:00 is 7 hours. Reading only the first entry gave
    // 4, and the widest window (10:00–20:00) would give 10.
    const split = [
      {
        id: "p1",
        workingHours: [
          { day: "monday", openTime: "10:00", closeTime: "14:00" },
          { day: "monday", openTime: "17:00", closeTime: "20:00" },
        ],
      },
    ];
    const result = occupancy(
      split,
      [{ professionalId: "p1", duration: 210, status: "completed", scheduledDate: "2026-09-28" }],
      week,
    );
    expect(result.availableMinutes).toBe(420);
    expect(result.rate).toBe(50);
  });

  describe("takes approved time off out of working time", () => {
    // Monday to Friday, 09:00–17:00: 480 minutes a day, 2400 in the week.
    const fullWeek = ["monday", "tuesday", "wednesday", "thursday", "friday"].map((day) => ({
      day,
      openTime: "09:00",
      closeTime: "17:00",
    }));
    const staff = [
      { id: "ana", workingHours: fullWeek },
      { id: "eva", workingHours: fullWeek },
    ];
    const booked = [
      { professionalId: "ana", duration: 240, status: "completed", scheduledDate: "2026-09-28" },
    ];

    it("a professional's holiday is not free time", () => {
      const result = occupancy(staff, booked, week, [
        { professionalId: "eva", kind: "vacation", startDate: "2026-09-29", endDate: "2026-10-01", status: "approved" },
      ]);
      // Eva is away three days: 4800 - 3 × 480.
      expect(result.availableMinutes).toBe(3360);
      expect(result.professionalsWithSchedule).toBe(2);
    });

    it("a salon closure takes the day from everyone", () => {
      const result = occupancy(staff, booked, week, [
        { professionalId: null, kind: "closure", startDate: "2026-10-02", endDate: "2026-10-02" },
      ]);
      expect(result.availableMinutes).toBe(4800 - 2 * 480);
    });

    it("a stretch of hours takes only those minutes, and only inside the shift", () => {
      const result = occupancy(staff, booked, week, [
        // 10:00–12:00 inside Ana's Monday shift: 120 minutes.
        { professionalId: "ana", kind: "other", startDate: "2026-09-28", endDate: "2026-09-28", startTime: "10:00", endTime: "12:00" },
        // 16:00–19:00 runs past Eva's 17:00 close: only 60 minutes come off.
        { professionalId: "eva", kind: "day_off", startDate: "2026-09-29", endDate: "2026-09-29", startTime: "16:00", endTime: "19:00" },
      ]);
      expect(result.availableMinutes).toBe(4800 - 120 - 60);
    });

    it("a block that overlaps another is not taken out twice", () => {
      const result = occupancy(staff, booked, week, [
        { professionalId: null, kind: "closure", startDate: "2026-09-28", endDate: "2026-09-28" },
        { professionalId: "ana", kind: "vacation", startDate: "2026-09-28", endDate: "2026-09-29" },
      ]);
      // Monday is gone for both (960); Tuesday for Ana only (480).
      expect(result.availableMinutes).toBe(4800 - 960 - 480);
    });

    it("ignores requests that are pending or rejected", () => {
      const result = occupancy(staff, booked, week, [
        { professionalId: "eva", kind: "vacation", startDate: "2026-09-28", endDate: "2026-10-02", status: "pending" },
        { professionalId: "ana", kind: "vacation", startDate: "2026-09-28", endDate: "2026-10-02", status: "rejected" },
      ]);
      expect(result.availableMinutes).toBe(4800);
    });

    it("leaves a professional with no schedule out, time off or not", () => {
      const result = occupancy([{ id: "luz", workingHours: [] }], [], week, [
        { professionalId: "luz", kind: "other", startDate: "2026-09-28", endDate: "2026-09-28", startTime: "10:00", endTime: "12:00" },
      ]);
      expect(result).toMatchObject({ availableMinutes: 0, rate: null, professionalsWithSchedule: 0 });
    });
  });
});
