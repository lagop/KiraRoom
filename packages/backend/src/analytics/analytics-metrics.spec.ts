/**
 * The analytics screens showed figures that were not measured: "clientas
 * recurrentes" was 40 % of the appointment count, revenue included confirmed
 * appointments nobody had paid, months were cut on the server's UTC clock and
 * "vs last month" set six months against one. These tests pin each
 * definition with fixed data so the numbers can only come from the rows.
 */
import {
  AnalyticsAppointment,
  AnalyticsVisitRow,
  appointmentValueCents,
  busyMinutes,
  clientRetention,
  closedRates,
  newClientCount,
  revenueCents,
  visitParts,
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
      apt({ status: "cancelled", paymentStatus: "refunded", amountPaid: 0 }), // cancelled and given back (kept money: D9 below)
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

describe("revenue is money the salon took and kept", () => {
  const reward = (moneyCents: number) => ({ loyalty: { rewardName: "Corte gratis", catalogueCents: moneyCents, moneyCents } });

  it("leaves out what a loyalty reward covered: points are not revenue (D4)", () => {
    // A 50 € visit: 10 € paid with points, 40 € with a card. amountPaid
    // reads 50 €, Caja took 40 €, the invoice shows a 10 € discount.
    const visit = apt({ amountPaid: 5000, discount: reward(1000) });
    expect(revenueCents(visit)).toBe(4000);
    const s = summarize([visit, apt({ amountPaid: 3000 })]);
    expect(s.revenue).toBe(7000);
    expect(s.avgTicket).toBe(3500);
    // Paid entirely with points: nothing came in.
    expect(revenueCents(apt({ amountPaid: 2500, discount: reward(2500) }))).toBe(0);
    // A till discount is not the reward: it already lowered the price.
    expect(revenueCents(apt({ amountPaid: 4500, discount: { pos: { cents: 500 } } }))).toBe(4500);
  });

  it("counts what was kept of a paid visit cancelled without a refund, net of partial refunds (D9)", () => {
    // Paid 40 €, cancelled, nothing given back: the salon kept 40 €.
    expect(revenueCents(apt({ status: "cancelled", paymentStatus: "paid", amountPaid: 4000 }))).toBe(4000);
    // 15 € of it given back: the refund lowered amountPaid to 25 €.
    expect(revenueCents(apt({ status: "cancelled", paymentStatus: "paid", amountPaid: 2500 }))).toBe(2500);
    // All of it given back.
    expect(revenueCents(apt({ status: "cancelled", paymentStatus: "refunded", amountPaid: 0 }))).toBe(0);
    // A prepayment kept on a no-show.
    expect(revenueCents(apt({ status: "no_show", paymentStatus: "pending", amountPaid: 1000 }))).toBe(1000);
    // A visit still to come, partly paid: not revenue until it is paid.
    expect(revenueCents(apt({ status: "confirmed", paymentStatus: "pending", amountPaid: 1000 }))).toBe(0);

    const kept = apt({ status: "cancelled", paymentStatus: "paid", amountPaid: 4000, scheduledDate: new Date("2026-10-01T00:00:00Z") });
    const s = summarize([kept, apt({ amountPaid: 3000 })]);
    // Revenue, dated by the visit's day; but not a booking and not a ticket.
    expect(s).toMatchObject({ revenue: 7000, appointments: 1, paidAppointments: 1, avgTicket: 3000 });
    expect(dailyMetrics([kept], { start: "2026-10-01", end: "2026-10-01" })).toEqual([
      { date: "2026-10-01", appointments: 0, revenue: 4000 },
    ]);
    expect(monthlyRevenue([kept], { start: "2026-10-01", end: "2026-10-01" })).toEqual([{ month: "2026-10", revenue: 4000 }]);
  });
});

describe("a visit with several services is split by service (D5)", () => {
  const ana = { id: "p1", firstName: "Ana", lastName: "Ruiz", profileImage: null };
  const eva = { id: "p2", firstName: "Eva", lastName: "Gil", profileImage: null };
  const at = (hhmm: string) => new Date(`2026-10-01T${hhmm}:00.000Z`); // Madrid is UTC+2 that day
  let n = 0;
  const row = (over: Partial<AnalyticsVisitRow>): AnalyticsVisitRow => ({
    id: `r${++n}`,
    professionalId: "p1",
    scheduledStart: null,
    scheduledEnd: null,
    isParallel: false,
    type: "active",
    status: "pending",
    ...over,
  });
  // Colour (45 €, Ana, 10:00-10:45), processing (nobody, 10:45-11:15),
  // rinse (15 €, Eva, 11:15-11:30); paid 60 €, of which 6 € with points.
  const colourAndRinse = apt({
    serviceId: "s-colour",
    serviceName: "Color",
    professionalId: "p1",
    professional: ana,
    amountPaid: 6000,
    discount: { loyalty: { moneyCents: 600, catalogueCents: 600 } },
    scheduledTime: "10:00",
    duration: 90,
    services: [
      row({ serviceId: "s-colour", serviceName: "Color", servicePrice: "45.00", professionalId: "p1", scheduledStart: at("08:00"), scheduledEnd: at("08:45") }),
      row({ serviceId: "s-colour", serviceName: "Color", servicePrice: "45.00", professionalId: null, type: "processing", scheduledStart: at("08:45"), scheduledEnd: at("09:15") }),
      row({ serviceId: "s-rinse", serviceName: "Aclarado", servicePrice: "15.00", professionalId: "p2", professional: eva, scheduledStart: at("09:15"), scheduledEnd: at("09:30") }),
    ],
  });

  it("shares the visit's revenue over its services by list price, in cents that add up", () => {
    const parts = visitParts(colourAndRinse);
    expect(parts.map((p) => [p.serviceName, p.professional?.id, p.revenueCents])).toEqual([
      ["Color", "p1", 4050], // 54 € x 45/60
      ["Aclarado", "p2", 1350], // 54 € x 15/60
    ]);
    expect(parts.reduce((s, p) => s + p.revenueCents, 0)).toBe(revenueCents(colourAndRinse));
    // A cancelled row is no longer part of the visit; one service left is the visit as before.
    const one = {
      ...colourAndRinse,
      services: colourAndRinse.services!.map((r) => (r.professionalId === "p2" ? { ...r, status: "cancelled" } : r)),
    };
    expect(visitParts(one)).toEqual([{ serviceKey: "s-colour", serviceName: "Color", professional: ana, revenueCents: 5400 }]);
  });

  it("credits each service and each professional with their part", () => {
    const single = apt({ serviceId: "s-cut", serviceName: "Corte", professionalId: "p2", professional: eva, amountPaid: 2000 });
    expect(topServices([colourAndRinse, single])).toEqual([
      { name: "Color", count: 1, revenue: 4050 },
      { name: "Corte", count: 1, revenue: 2000 },
      { name: "Aclarado", count: 1, revenue: 1350 },
    ]);
    expect(servicePopularity([colourAndRinse, single]).map((s) => [s.name, s.count])).toEqual([
      ["Aclarado", 1],
      ["Color", 1],
      ["Corte", 1],
    ]);
    expect(topProfessionals([colourAndRinse, single]).map((p) => [p.id, p.appointments, p.revenue])).toEqual([
      ["p1", 1, 4050],
      ["p2", 2, 3350], // the rinse and her own cut: two visits
    ]);
  });

  it("charges each professional's own minutes to occupancy, and nobody's for processing", () => {
    expect([...busyMinutes(colourAndRinse, "Europe/Madrid")]).toEqual([
      ["p1", 45],
      ["p2", 15],
    ]);
    // Rows with no stored times are laid out from the start, one after another.
    const unplaced = {
      ...colourAndRinse,
      services: [
        row({ servicePrice: "30.00", serviceDuration: 30, professionalId: "p1" }),
        row({ servicePrice: "20.00", serviceDuration: 20, professionalId: "p2" }),
      ],
      duration: 60, // 10 more minutes of add-ons: the visit's professional
    };
    expect(Object.fromEntries(busyMinutes(unplaced, "Europe/Madrid"))).toEqual({ p1: 40, p2: 20 });
    // One service: its professional for its duration, as before.
    expect([...busyMinutes(apt({ professionalId: "p1", duration: 50 }), "Europe/Madrid")]).toEqual([["p1", 50]]);

    const schedule = [{ day: "thursday", openTime: "10:00", closeTime: "14:00" }];
    const result = occupancy(
      [
        { id: "p1", workingHours: schedule },
        { id: "p2", workingHours: schedule },
      ],
      [colourAndRinse],
      { start: "2026-10-01", end: "2026-10-01" },
      [],
      "Europe/Madrid",
    );
    expect(result).toMatchObject({ bookedMinutes: 60, availableMinutes: 480 });
  });
});

describe("closing rates have one definition (U9, S7)", () => {
  const day = (d: string) => new Date(`${d}T00:00:00Z`);

  it("are over appointments closed up to yesterday", () => {
    const rows = [
      { status: "completed", scheduledDate: day("2026-10-18") },
      { status: "completed", scheduledDate: day("2026-10-18") },
      { status: "completed", scheduledDate: day("2026-10-19") },
      { status: "cancelled", scheduledDate: day("2026-10-19") },
      { status: "no_show", scheduledDate: day("2026-10-19") },
      { status: "confirmed", scheduledDate: day("2026-10-19") }, // never closed: left out
      { status: "completed", scheduledDate: day("2026-10-20") }, // today: left out
      { status: "cancelled", scheduledDate: day("2026-10-25") }, // cancelled ahead: left out until its day passes
    ];
    expect(closedRates(rows, "2026-10-20")).toEqual({
      through: "2026-10-19",
      closed: 5,
      completed: 3,
      cancelled: 1,
      noShow: 1,
      completionRate: 60,
      cancellationRate: 20,
      noShowRate: 20,
    });
    expect(closedRates([], "2026-10-20")).toMatchObject({
      closed: 0,
      completionRate: null,
      cancellationRate: null,
      noShowRate: null,
    });
  });

  it("are given per professional, with the same definition", () => {
    const ana = { id: "p1", firstName: "Ana", lastName: "Ruiz", profileImage: null };
    const rows = [
      apt({ professional: ana, status: "completed", scheduledDate: day("2026-10-18") }),
      apt({ professional: ana, status: "no_show", paymentStatus: "pending", scheduledDate: day("2026-10-18") }),
      apt({ professional: ana, status: "cancelled", paymentStatus: "pending", scheduledDate: day("2026-10-19") }),
      apt({ professional: ana, status: "cancelled", paymentStatus: "pending", scheduledDate: day("2026-10-19") }),
      apt({ professional: ana, status: "completed", scheduledDate: day("2026-10-20") }), // today
    ];
    const [row] = topProfessionals(rows, 5, { today: "2026-10-20" });
    expect(row).toMatchObject({
      appointments: 3, // cancelled visits are not visits
      closedAppointments: 4,
      completedAppointments: 1,
      cancelledAppointments: 2,
      noShowAppointments: 1,
      completionRate: 25,
      cancellationRate: 50,
      noShowRate: 25,
    });
  });
});

describe("a professional's revenue adds the services the till sold without an appointment (D6)", () => {
  const ana = { id: "p1", firstName: "Ana", lastName: "Ruiz", profileImage: null };
  const bea = { id: "p2", firstName: "Bea", lastName: "Gil", profileImage: null };

  it("adds them apart, so the panel can label them, and never twice", () => {
    const rows = [apt({ professional: ana, amountPaid: 4000 })];
    const result = topProfessionals(rows, 5, {
      tillServices: [
        { professionalId: "p1", keptCents: 1500 },
        { professionalId: "p2", keptCents: 2500 }, // Bea: only the till this period
        { professionalId: "p2", keptCents: 0 }, // given back in full
        { professionalId: null, keptCents: 900 }, // nobody named: nobody's
        { professionalId: "p9", keptCents: 700 }, // unknown to the salon: left out
      ],
      directory: new Map([["p2", bea]]),
    });
    expect(result.map((p) => [p.id, p.revenue, p.tillServicesCents, p.revenueCents, p.appointments])).toEqual([
      ["p1", 4000, 1500, 5500, 1],
      ["p2", 0, 2500, 2500, 0],
    ]);
  });
});

describe("new clients are first visits (D7)", () => {
  it("counts clients whose first completed visit is in the period", () => {
    // a twice in the period: one client; b came before; an imported client
    // with no visit is not in the list at all.
    expect(newClientCount(["a", "a", "b", "c"], new Set(["b"]))).toBe(2);
    expect(newClientCount([], new Set())).toBe(0);
  });
});
