import { appointmentKeptShares, keptShare, saleLineAfterRefunds } from "./commission-refunds";
import { CommissionsService } from "./commissions.service";

/** What was refunded no longer earns a commission: in proportion, then none. */
describe("commissions after refunds", () => {
  it("keptShare: what is left of what was charged", () => {
    expect(keptShare(3000, 0)).toBe(1);
    expect(keptShare(3000, 1000)).toBeCloseTo(2 / 3);
    expect(keptShare(3000, 3000)).toBe(0);
    expect(keptShare(3000, 5000)).toBe(0);
    // Nothing charged in money (all with points): as before.
    expect(keptShare(0, 0)).toBe(1);
  });

  it("a till sale line: its commission and base scaled by what is left of it", () => {
    expect(saleLineAfterRefunds({ commissionBaseCents: 3000, commissionAmount: 300, totalCents: 3000, refundedCents: 1000 })).toEqual({
      baseCents: 2000,
      commission: 200,
      kept: 2 / 3,
    });
    expect(saleLineAfterRefunds({ commissionBaseCents: 3000, commissionAmount: 300, totalCents: 3000, refundedCents: 3000 }).commission).toBe(0);
    // Lines from before the column: nothing refunded.
    expect(saleLineAfterRefunds({ commissionBaseCents: 3000, commissionAmount: 300, totalCents: 3000 }).commission).toBe(300);
  });

  it("an appointment: the share of its money payments the salon kept, only for those with a refund", async () => {
    const findMany = jest.fn(async () => [
      { appointmentId: "a1", amount: 3000, status: "paid", refunds: [{ amount: 1000 }] },
      { appointmentId: "a1", amount: 1000, status: "paid", refunds: [] },
      { appointmentId: "a2", amount: 2000, status: "refunded", refunds: [] }, // before refund rows: all of it
      { appointmentId: "a3", amount: 2000, status: "paid", refunds: [] },
    ]);
    const kept = await appointmentKeptShares({ payment: { findMany } }, "t1", ["a1", "a2", "a3"]);
    expect(kept.get("a1")).toBe(0.75);
    expect(kept.get("a2")).toBe(0);
    expect(kept.has("a3")).toBe(false);
    expect((findMany.mock.calls[0] as any)[0].where).toEqual({
      tenantId: "t1",
      appointmentId: { in: ["a1", "a2", "a3"] },
      status: { in: ["paid", "refunded"] },
      method: { not: "loyalty_points" },
    });
  });

  it("the summary counts a partly refunded visit and a partly refunded walk-in line at what is left; a line refunded whole is gone", async () => {
    const prisma: any = {
      professional: { findFirst: jest.fn(async () => ({ id: "p1", firstName: "Ana", lastName: "Pro", commissionRate: 10 })) },
      tenant: { findUnique: jest.fn(async () => ({ timezone: "Europe/Madrid" })) },
      appointment: {
        findMany: jest.fn(async () => [
          {
            id: "a1",
            scheduledDate: new Date(),
            totalAmount: 4000,
            commissionRate: null,
            commissionAmount: null,
            commissionPaid: false,
            client: { firstName: "C", lastName: "L" },
            service: { name: "Mechas" },
          },
        ]),
      },
      payment: { findMany: jest.fn(async () => [{ appointmentId: "a1", amount: 4000, status: "paid", refunds: [{ amount: 1000 }] }]) },
      posSaleLine: {
        findMany: jest.fn(async () => [
          { id: "l1", createdAt: new Date(), description: "Corte", commissionBaseCents: 3000, commissionRate: 10, commissionAmount: 300, commissionPaid: false, professionalId: "p1", totalCents: 3000, refundedCents: 1500 },
          { id: "l2", createdAt: new Date(), description: "Peinado", commissionBaseCents: 2000, commissionRate: 10, commissionAmount: 200, commissionPaid: false, professionalId: "p1", totalCents: 2000, refundedCents: 2000 },
        ]),
      },
    };
    const summary = await new CommissionsService(prisma).getCommissionSummary("t1", "p1");
    expect(summary.appointments.map((a) => [a.id, a.amount, a.commissionAmount])).toEqual([
      ["a1", 3000, 300],
      ["l1", 1500, 150],
    ]);
    expect(summary.pendingCommission).toBe(450);
  });
});
