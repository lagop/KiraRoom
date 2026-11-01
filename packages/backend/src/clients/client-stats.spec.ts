import { Prisma } from "@prisma/client";
import { clientStatsFrom, recomputeClientStats, refreshClientStats } from "./client-stats";
import { PaymentsService } from "../payments/payments.service";

/**
 * Nothing wrote a client's visits or spend: every client had 0 visits, no
 * last visit and 0 EUR, so re-engagement campaigns took everyone for an
 * inactive client. They are now computed from completed appointments and
 * recorded payments (cents in, euros out).
 */

const CREATED = new Date("2025-01-10T09:00:00Z");

function db(opts: {
  client?: { createdAt: Date } | null;
  visits?: { count: number; first?: Date | null; last?: Date | null };
  paidCents?: number | null;
} = {}) {
  return {
    client: {
      findFirst: jest.fn(async () => (opts.client === undefined ? { createdAt: CREATED } : opts.client)),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    appointment: {
      aggregate: jest.fn(async () => ({
        _count: { _all: opts.visits?.count ?? 0 },
        _min: { scheduledDate: opts.visits?.first ?? null },
        _max: { scheduledDate: opts.visits?.last ?? null },
      })),
    },
    payment: { aggregate: jest.fn(async () => ({ _sum: { amount: opts.paidCents ?? null } })) },
  };
}

describe("clientStatsFrom", () => {
  it("turns paid cents into euros and averages them over the visits, 2 decimals", () => {
    const s = clientStatsFrom({
      visitCount: 3,
      firstVisit: new Date("2025-02-01"),
      lastVisit: new Date("2025-06-01"),
      paidCents: 10_000, // 100,00 EUR
      createdAt: CREATED,
    });
    expect(s.visitCount).toBe(3);
    expect(s.totalSpent.toString()).toBe("100");
    expect(s.averageSpent.toString()).toBe("33.33");
    expect(s.firstVisit).toEqual(new Date("2025-02-01"));
    expect(s.lastVisit).toEqual(new Date("2025-06-01"));
  });

  it("a client with no completed visit: first visit = her creation, no last visit, average 0", () => {
    const s = clientStatsFrom({ visitCount: 0, firstVisit: null, lastVisit: null, paidCents: 2_550, createdAt: CREATED });
    expect(s).toMatchObject({ visitCount: 0, firstVisit: CREATED, lastVisit: null });
    // A product bought at the till is still money she spent.
    expect(s.totalSpent.toString()).toBe("25.5");
    expect(s.averageSpent.toString()).toBe("0");
  });

  it("rounds the average half up", () => {
    // 0,05 EUR over 2 visits = 0,025 -> 0,03
    const s = clientStatsFrom({ visitCount: 2, firstVisit: CREATED, lastVisit: CREATED, paidCents: 5, createdAt: CREATED });
    expect(s.averageSpent.toString()).toBe("0.03");
  });
});

describe("recomputeClientStats", () => {
  it("counts her completed appointments and her paid payments without points, in her salon", async () => {
    const d = db({
      visits: { count: 2, first: new Date("2025-03-01"), last: new Date("2025-09-15") },
      paidCents: 7_490,
    });

    const stats = await recomputeClientStats(d, "t1", "c1");

    expect(d.appointment.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tenantId: "t1", clientId: "c1", status: "completed" } }),
    );
    expect(d.payment.aggregate).toHaveBeenCalledWith({
      where: { tenantId: "t1", clientId: "c1", status: "paid", method: { not: "loyalty_points" } },
      _sum: { amount: true },
    });
    expect(d.client.updateMany).toHaveBeenCalledWith({
      where: { id: "c1", tenantId: "t1" },
      data: {
        visitCount: 2,
        firstVisit: new Date("2025-03-01"),
        lastVisit: new Date("2025-09-15"),
        totalSpent: new Prisma.Decimal("74.9"),
        averageSpent: new Prisma.Decimal("37.45"),
      },
    });
    expect(stats?.totalSpent.toString()).toBe("74.9");
  });

  it("writes nothing for a client of another salon", async () => {
    const d = db({ client: null });
    expect(await recomputeClientStats(d, "t1", "c-other")).toBeNull();
    expect(d.client.updateMany).not.toHaveBeenCalled();
  });

  it("is the same the second time (recomputed, never incremented)", async () => {
    const d = db({ visits: { count: 1, first: CREATED, last: CREATED }, paidCents: 3_000 });
    await recomputeClientStats(d, "t1", "c1");
    await recomputeClientStats(d, "t1", "c1");
    const [first, second] = d.client.updateMany.mock.calls as any[];
    expect(second[0]).toEqual(first[0]);
  });
});

describe("refreshClientStats", () => {
  it("recomputes each client once and never throws", async () => {
    const d = db();
    d.appointment.aggregate.mockRejectedValueOnce(new Error("db down"));
    await expect(refreshClientStats(d, "t1", ["c1", null, "c1", undefined, "c2"])).resolves.toBeUndefined();
    expect(d.client.findFirst).toHaveBeenCalledTimes(2);
    expect(d.client.updateMany).toHaveBeenCalledTimes(1); // c1 failed, c2 written
  });
});

describe("payments recompute the client's figures", () => {
  function service() {
    const prisma: any = {
      ...db({ paidCents: 4_000 }),
      payment: {
        aggregate: jest.fn(async () => ({ _sum: { amount: 4_000 } })),
        create: jest.fn(async ({ data }: any) => ({ id: "pay1", ...data })),
        findFirst: jest.fn(async () => ({ id: "pay1", tenantId: "t1", clientId: "c1", status: "paid", amount: 4_000, method: "cash", refunds: [], updatedAt: new Date(0) })),
        update: jest.fn(async ({ data }: any) => ({ id: "pay1", clientId: "c1", amount: 4_000, ...data })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      refund: { create: jest.fn(async ({ data }: any) => ({ id: "r1", ...data })) },
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    prisma.client.findFirst = jest.fn(async () => ({ id: "c1", createdAt: CREATED }));
    return { prisma, payments: new PaymentsService(prisma) };
  }

  it("after a payment is recorded", async () => {
    const { prisma, payments } = service();
    await payments.createPayment("t1", null, { clientId: "c1", amount: 4_000, method: "cash", status: "paid" });
    expect(prisma.client.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "c1", tenantId: "t1" }, data: expect.objectContaining({ totalSpent: new Prisma.Decimal(40) }) }),
    );
  });

  it("after a refund", async () => {
    const { prisma, payments } = service();
    await payments.refundPayment("t1", "pay1", { reason: "Error al cobrar" });
    expect(prisma.client.updateMany).toHaveBeenCalledTimes(1);
  });
});
