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
    ...overrides,
  };
}

describe("AnalyticsService", () => {
  afterEach(() => jest.useRealTimers());

  it("counts recurring clients from appointment history, not as 40 % of appointments", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-02T10:00:00Z"));
    const prisma = makePrisma();
    prisma.client.count.mockResolvedValue(4);
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
      newClients: 4,
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
          professional: { id: "p1", firstName: "Ana", lastName: "Ruiz", profileImage: null },
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
          professional: { id: "p1", firstName: "Ana", lastName: "Ruiz", profileImage: null },
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
    // New clients: from Madrid midnight (22:00 UTC the day before).
    expect(prisma.client.count.mock.calls[0][0].where.createdAt.gte).toEqual(
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

  it("limits Staff to their own appointments", async () => {
    jest.useFakeTimers().setSystemTime(new Date("2026-10-02T10:00:00Z"));
    const prisma = makePrisma();
    const service = new AnalyticsService(prisma as any);

    await service.getOverview("t1", 1, "p9");

    for (const [args] of prisma.appointment.findMany.mock.calls) {
      expect(args.where.professionalId).toBe("p9");
    }
    expect(prisma.professional.findMany.mock.calls[0][0].where).toMatchObject({ id: "p9" });
  });
});
