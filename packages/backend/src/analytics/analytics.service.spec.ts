/**
 * The service wires the definitions in analytics-metrics.ts to the database.
 * Two things went wrong here before: "clientas recurrentes" was
 * `Math.floor(totalAppointments * 0.4)`, and every period was cut with the
 * server's clock (UTC in production), so on the evening of the last day of a
 * month in Madrid the panel already showed the next month. These tests feed
 * fixed rows through a mocked Prisma and check what comes out and what is
 * asked for.
 */
import { AnalyticsService } from "./analytics.service";

function makePrisma(overrides: Record<string, any> = {}) {
  return {
    tenant: { findUnique: jest.fn().mockResolvedValue({ timezone: "Europe/Madrid" }) },
    appointment: {
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
    },
    client: { count: jest.fn().mockResolvedValue(0) },
    professional: { findMany: jest.fn().mockResolvedValue([]) },
    timeOff: { findMany: jest.fn().mockResolvedValue([]) },
    posSaleLine: { findMany: jest.fn().mockResolvedValue([]) },
    ...overrides,
  };
}

const ana = { id: "p1", firstName: "Ana", lastName: "Ruiz", profileImage: null };

/** A query of loadAppointments for the period starting on `day`. */
const loadsFrom = (args: any, day: string) =>
  !args.distinct && args.where?.scheduledDate?.gte?.toISOString?.().slice(0, 10) === day;

describe("AnalyticsService", () => {
  afterEach(() => jest.useRealTimers());

  it("counts recurring clients from appointment history, not as 40 % of appointments", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-02T10:00:00Z"));
    const prisma = makePrisma();
    prisma.appointment.count.mockResolvedValue(50);
    prisma.appointment.findMany
      // completed appointments in the period, one row each
      .mockResolvedValueOnce([
        { clientId: "a" },
        { clientId: "a" },
        { clientId: "b" },
        { clientId: "c" },
        { clientId: "d" },
      ])
      // clients among those served before the period
      .mockResolvedValueOnce([{ clientId: "c" }]);
    const service = new AnalyticsService(prisma as any);

    const insights = await service.getClientInsights("t1", 3);

    expect(insights).toEqual({
      period: { start: "2026-08-01", end: "2026-10-02" },
      // a, b and d came for the first time; c had come before.
      newClients: 3,
      clientsServed: 4,
      returningClients: 2, // a (two visits) and c (came before)
      totalAppointments: 50,
      retentionRate: 50,
    });
    // The old formula would have said floor(50 * 0.4) = 20.
    expect(insights.returningClients).not.toBe(20);
    const earlierQuery = prisma.appointment.findMany.mock.calls[1][0];
    expect(earlierQuery.where).toMatchObject({
      tenantId: "t1",
      status: "completed",
      clientId: { in: ["a", "b", "c", "d"] },
      scheduledDate: { lt: new Date("2026-08-01T00:00:00.000Z") },
    });
    // New clients no longer come from client records created in the period.
    expect(prisma.client.count).not.toHaveBeenCalled();
  });

  it("cuts the overview at the salon's midnight, not the server's", async () => {
    // 22:30 UTC on 30 September is 00:30 on 1 October in Madrid: the salon
    // is already in October.
    jest.useFakeTimers().setSystemTime(new Date("2026-09-30T22:30:00Z"));
    const prisma = makePrisma();
    prisma.appointment.findMany
      .mockResolvedValueOnce([
        {
          status: "completed",
          paymentStatus: "paid",
          totalAmount: 4500,
          amountPaid: 0,
          price: 45,
          scheduledDate: new Date("2026-10-01T00:00:00Z"),
          duration: 60,
          professionalId: "p1",
          serviceId: "s1",
          service: { name: "Corte" },
          professional: ana,
        },
        {
          status: "confirmed",
          paymentStatus: "pending",
          totalAmount: 3000,
          amountPaid: 0,
          price: 30,
          scheduledDate: new Date("2026-10-01T00:00:00Z"),
          duration: 30,
          professionalId: "p1",
          serviceId: "s1",
          service: { name: "Corte" },
          professional: ana,
        },
      ])
      .mockResolvedValueOnce([
        {
          status: "completed",
          paymentStatus: "paid",
          totalAmount: 3000,
          scheduledDate: new Date("2026-09-01T00:00:00Z"),
        },
      ]);
    prisma.professional.findMany.mockResolvedValue([
      { id: "p1", workingHours: [{ day: "thursday", openTime: "10:00", closeTime: "14:00" }] },
    ]);
    const service = new AnalyticsService(prisma as any);

    const overview = await service.getOverview("t1", 1);

    expect(overview.period).toEqual({ start: "2026-10-01", end: "2026-10-01" });
    expect(overview.previousPeriod).toEqual({ start: "2026-09-01", end: "2026-09-01" });
    const [currentQuery, previousQuery] = prisma.appointment.findMany.mock.calls.map((c: any[]) => c[0]);
    expect(currentQuery.where.scheduledDate).toEqual({
      gte: new Date("2026-10-01T00:00:00.000Z"),
      lt: new Date("2026-10-02T00:00:00.000Z"),
    });
    expect(previousQuery.where.scheduledDate.gte).toEqual(new Date("2026-09-01T00:00:00.000Z"));
    // Till sales: from Madrid midnight (22:00 UTC the day before).
    expect(prisma.posSaleLine.findMany.mock.calls[0][0].where.createdAt.gte).toEqual(
      new Date("2026-09-30T22:00:00.000Z"),
    );

    // Only the paid appointment is revenue; money stays in cents.
    expect(overview.stats).toMatchObject({
      totalRevenue: 4500,
      totalAppointments: 2,
      paidAppointments: 1,
      avgOrderValue: 4500,
      revenueChange: 50,
    });
    // 1 October 2026 is a Thursday: 240 working minutes, 90 booked.
    expect(overview.occupancy).toMatchObject({ bookedMinutes: 90, availableMinutes: 240, rate: 37.5 });
    expect(overview.currencyUnit).toBe("cents");
  });

  it("new clients are those whose first completed visit is in the period, not imported records (D7)", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-20T10:00:00Z"));
    const prisma = makePrisma();
    const visit = (clientId: string, status: string, day: string) => ({
      clientId,
      status,
      paymentStatus: "pending",
      amountPaid: 0,
      totalAmount: 0,
      scheduledDate: new Date(`${day}T00:00:00Z`),
      professionalId: "p1",
      professional: ana,
    });
    prisma.appointment.findMany.mockImplementation(async (args: any) => {
      if (loadsFrom(args, "2026-10-01")) {
        return [
          visit("new", "completed", "2026-10-05"), // first visit ever: new
          visit("new", "completed", "2026-10-12"), // her second: still one client
          visit("regular", "completed", "2026-10-06"), // came in September too
          visit("booked", "confirmed", "2026-10-25"), // not come yet
        ];
      }
      if (loadsFrom(args, "2026-09-01")) {
        return [visit("regular", "completed", "2026-09-03"), visit("sept", "completed", "2026-09-10")];
      }
      if (args.distinct) {
        // Served before the period's first day.
        const before = args.where.scheduledDate.lt.toISOString().slice(0, 10);
        return before === "2026-10-01" ? [{ clientId: "regular" }] : [];
      }
      return [];
    });
    // The client imported this month (Client.createdAt in October, source
    // "import") has no appointment at all: nothing above mentions her.
    prisma.client.count.mockResolvedValue(1500);
    const service = new AnalyticsService(prisma as any);

    const overview = await service.getOverview("t1", 1);

    expect(overview.stats.newClients).toBe(1);
    // September had two first visits (regular, sept): 1 against 2.
    expect(overview.stats.clientsChange).toBe(-50);
    expect(prisma.client.count).not.toHaveBeenCalled();
  });

  it("adds what the till sold without an appointment: per professional and as tillSales (D6, S6)", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-20T10:00:00Z"));
    const prisma = makePrisma();
    prisma.appointment.findMany.mockImplementation(async (args: any) =>
      loadsFrom(args, "2026-10-01")
        ? [
            {
              clientId: "c1",
              status: "completed",
              paymentStatus: "paid",
              amountPaid: 5000,
              totalAmount: 5000,
              scheduledDate: new Date("2026-10-05T00:00:00Z"),
              professionalId: "p1",
              professional: ana,
            },
          ]
        : [],
    );
    prisma.posSaleLine.findMany.mockResolvedValue([
      // A walk-in cut by Bea, who has no appointment this month.
      { id: "l1", saleId: "s1", kind: "service", professionalId: "p2", totalCents: 3000, refundedCents: 0, quantity: 1, refundedQuantity: 0 },
      // A shampoo, half given back.
      { id: "l2", saleId: "s1", kind: "product", professionalId: null, totalCents: 2000, refundedCents: 500, quantity: 2, refundedQuantity: 1 },
      // A service given back in full: nothing left.
      { id: "l3", saleId: "s2", kind: "service", professionalId: "p1", totalCents: 1000, refundedCents: 1000, quantity: 1, refundedQuantity: 1 },
    ]);
    prisma.professional.findMany.mockImplementation(async (args: any) =>
      args.where.id ? [{ id: "p2", firstName: "Bea", lastName: "Gil", profileImage: null }] : [],
    );
    const service = new AnalyticsService(prisma as any);

    const overview = await service.getOverview("t1", 1);

    const lineQuery = prisma.posSaleLine.findMany.mock.calls[0][0];
    expect(lineQuery.where).toMatchObject({ tenantId: "t1", kind: { in: ["service", "product"] }, appointmentId: null });
    expect(overview.tillSales).toEqual({
      totalCents: 4500,
      servicesCents: 3000,
      productsCents: 1500,
      sales: 1,
      refundedCents: 1500,
    });
    // Ingresos stays the appointments'; with the till, 50 + 45 €.
    expect(overview.stats.totalRevenue).toBe(5000);
    expect(overview.stats.totalRevenueWithTill).toBe(9500);
    const bea = overview.topProfessionals.find((p) => p.id === "p2")!;
    expect(bea).toMatchObject({ name: "Bea Gil", appointments: 0, revenue: 0, tillServicesCents: 3000, revenueCents: 3000 });
    const anaRow = overview.topProfessionals.find((p) => p.id === "p1")!;
    expect(anaRow).toMatchObject({ revenue: 5000, tillServicesCents: 0, revenueCents: 5000 });
    // The directory is asked only for the till's professionals, in this salon.
    const dirQuery = prisma.professional.findMany.mock.calls.find((c: any[]) => c[0].where.id)![0];
    expect(dirQuery.where).toEqual({ tenantId: "t1", id: { in: ["p2"] } });
  });

  it("gives the overview one set of rates: closed appointments up to yesterday (U9)", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-20T10:00:00Z"));
    const prisma = makePrisma();
    const row = (status: string, day: string) => ({
      status,
      paymentStatus: "pending",
      scheduledDate: new Date(`${day}T00:00:00Z`),
    });
    prisma.appointment.findMany.mockImplementation(async (args: any) =>
      loadsFrom(args, "2026-10-01")
        ? [
            row("completed", "2026-10-02"),
            row("completed", "2026-10-03"),
            row("cancelled", "2026-10-04"),
            row("no_show", "2026-10-05"),
            row("confirmed", "2026-10-19"), // still open
            row("completed", "2026-10-20"), // today: not counted yet
          ]
        : [],
    );
    const service = new AnalyticsService(prisma as any);

    const overview = await service.getOverview("t1", 1);

    expect(overview.rates).toEqual({
      through: "2026-10-19",
      closed: 4,
      completed: 2,
      cancelled: 1,
      noShow: 1,
      completionRate: 50,
      cancellationRate: 25,
      noShowRate: 25,
    });
  });

  it("answers the rates month by month for the evolution chart", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-20T10:00:00Z"));
    const prisma = makePrisma();
    prisma.appointment.findMany.mockResolvedValue([
      { status: "completed", scheduledDate: new Date("2026-09-10T00:00:00Z") },
      { status: "cancelled", scheduledDate: new Date("2026-09-11T00:00:00Z") },
      { status: "completed", scheduledDate: new Date("2026-10-02T00:00:00Z") },
    ]);
    const service = new AnalyticsService(prisma as any);

    const rates = await service.getAppointmentRates("t1", { months: 2 });

    expect(prisma.appointment.findMany.mock.calls[0][0].where.status).toEqual({
      in: ["completed", "cancelled", "no_show"],
    });
    expect(rates).toMatchObject({ period: { start: "2026-09-01", end: "2026-10-20" }, closed: 3, completionRate: 66.7 });
    expect(rates.byMonth).toEqual([
      expect.objectContaining({ month: "2026-09", closed: 2, cancellationRate: 50 }),
      expect.objectContaining({ month: "2026-10", closed: 1, completionRate: 100 }),
    ]);
  });

  it("takes the salon's approved time off in the period out of occupancy", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-02T10:00:00Z"));
    const prisma = makePrisma();
    prisma.professional.findMany.mockResolvedValue([
      { id: "p1", workingHours: [{ day: "thursday", openTime: "10:00", closeTime: "14:00" }] },
    ]);
    prisma.timeOff.findMany.mockResolvedValue([
      {
        professionalId: "p1",
        kind: "sick_leave",
        startDate: new Date("2026-10-01T00:00:00Z"),
        endDate: new Date("2026-10-01T00:00:00Z"),
        startTime: "12:00",
        endTime: "14:00",
        status: "approved",
      },
    ]);
    const service = new AnalyticsService(prisma as any);

    const overview = await service.getOverview("t1", 1);

    // The period is 1–2 October; only Thursday 1 has a shift: 240 minutes, 120 off.
    expect(overview.occupancy).toMatchObject({ availableMinutes: 120 });
    expect(prisma.timeOff.findMany.mock.calls[0][0].where).toMatchObject({
      tenantId: "t1",
      status: "approved",
      startDate: { lte: new Date("2026-10-02T00:00:00.000Z") },
      endDate: { gte: new Date("2026-10-01T00:00:00.000Z") },
    });
  });
});
