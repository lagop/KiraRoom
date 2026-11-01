import {
  REFUND_ADJUSTMENT_LABEL,
  clawbackAmount,
  clawedBackBySource,
  recordRefundClawbacks,
} from "./commission-clawback";
import { CommissionsService } from "./commissions.service";

/**
 * A refund given after the commission was paid takes it back with a
 * negative adjustment ("Ajuste por devolución"), linked to the refund, once
 * per refund and item; the paid period is not rewritten.
 */

/** A fake store with the unique (refundId, sourceKey) of the real table. */
function adjustmentsStore(rows: any[] = []) {
  return {
    rows,
    createMany: jest.fn(async ({ data, skipDuplicates }: any) => {
      let count = 0;
      for (const d of data) {
        const dup = rows.some((r) => r.refundId === d.refundId && r.sourceKey === d.sourceKey);
        if (dup) {
          if (!skipDuplicates) throw new Error("unique violation");
          continue;
        }
        rows.push({ id: `adj-${rows.length + 1}`, createdAt: new Date(), settled: false, settledAt: null, ...d });
        count++;
      }
      return { count };
    }),
    findMany: jest.fn(async ({ where }: any) =>
      rows.filter(
        (r) =>
          (where.tenantId === undefined || r.tenantId === where.tenantId) &&
          (where.professionalId === undefined || r.professionalId === where.professionalId) &&
          (where.settled === undefined || r.settled === where.settled) &&
          (where.sourceKey?.in === undefined || where.sourceKey.in.includes(r.sourceKey)) &&
          (where.id?.in === undefined || where.id.in.includes(r.id)) &&
          (where.createdAt?.gte === undefined || r.createdAt >= where.createdAt.gte) &&
          (where.createdAt?.lt === undefined || r.createdAt < where.createdAt.lt),
      ),
    ),
    updateMany: jest.fn(async ({ where, data }: any) => {
      let count = 0;
      for (const r of rows) {
        if (r.tenantId === where.tenantId && r.professionalId === where.professionalId && r.settled === where.settled) {
          Object.assign(r, data);
          count++;
        }
      }
      return { count };
    }),
  };
}

describe("clawbackAmount", () => {
  it("takes back the refund's share of the commission, negative, to the cent", () => {
    expect(clawbackAmount(300, 3000, 0, 1000)).toBe(-100);
    expect(clawbackAmount(300, 3000, 1000, 3000)).toBe(-200);
    expect(clawbackAmount(400, 3000, 0, 1000)).toBe(-133.33);
  });

  it("never more than what is left of it, and nothing when there is nothing to take", () => {
    expect(clawbackAmount(300, 3000, 2500, 5000)).toBe(-50);
    expect(clawbackAmount(300, 3000, 3000, 3000)).toBe(0);
    expect(clawbackAmount(0, 3000, 0, 1000)).toBe(0);
    expect(clawbackAmount(300, 0, 0, 0)).toBe(0);
  });
});

describe("recordRefundClawbacks", () => {
  function db(opts: { line?: any; appointment?: any; payments?: any[] } = {}) {
    const store = adjustmentsStore();
    return {
      store,
      db: {
        commissionAdjustment: store,
        posSaleLine: {
          findMany: jest.fn(async ({ where }: any) =>
            [opts.line].filter(
              (l) => l && where.id.in.includes(l.id) && l.kind === where.kind && l.commissionPaid === where.commissionPaid,
            ),
          ),
        },
        appointment: { findFirst: jest.fn(async () => opts.appointment ?? null) },
        payment: { findMany: jest.fn(async () => opts.payments ?? []) },
      },
    };
  }
  const paidLine = {
    id: "l1",
    kind: "service",
    professionalId: "p1",
    commissionPaid: true,
    commissionAmount: 300,
    totalCents: 3000,
    refundedCents: 1000, // after this refund
  };

  it("a walk-in line whose commission was paid: an adjustment for its professional, linked to the refund", async () => {
    const { db: d, store } = db({ line: paidLine });
    const n = await recordRefundClawbacks(d, { tenantId: "t1", refundId: "r1", amount: 1000, lines: [{ lineId: "l1", cents: 1000 }] });
    expect(n).toBe(1);
    expect(store.rows).toEqual([
      expect.objectContaining({
        tenantId: "t1",
        professionalId: "p1",
        refundId: "r1",
        posSaleLineId: "l1",
        sourceKey: "sale_line:l1",
        amount: -100,
        settled: false,
      }),
    ]);
  });

  it("is idempotent per refund: recording the same refund again adds nothing", async () => {
    const { db: d, store } = db({ line: paidLine });
    const refund = { tenantId: "t1", refundId: "r1", amount: 1000, lines: [{ lineId: "l1", cents: 1000 }] };
    await recordRefundClawbacks(d, refund);
    expect(await recordRefundClawbacks(d, refund)).toBe(0);
    expect(store.rows).toHaveLength(1);
  });

  it("a line not paid yet: nothing (its payout will count what is left)", async () => {
    const { db: d, store } = db({ line: { ...paidLine, commissionPaid: false } });
    await recordRefundClawbacks(d, { tenantId: "t1", refundId: "r1", amount: 1000, lines: [{ lineId: "l1", cents: 1000 }] });
    expect(store.rows).toEqual([]);
  });

  it("a visit whose commission was paid: its share of the money payments", async () => {
    const { db: d, store } = db({
      appointment: { id: "a1", professionalId: "p2", commissionPaid: true, commissionAmount: 400 },
      // 30,00 charged; this refund of 10,00 is already recorded.
      payments: [{ amount: 3000, status: "paid", refunds: [{ amount: 1000 }] }],
    });
    await recordRefundClawbacks(d, { tenantId: "t1", refundId: "r2", amount: 1000, appointmentId: "a1", method: "card" });
    expect(store.rows).toEqual([
      expect.objectContaining({ professionalId: "p2", appointmentId: "a1", sourceKey: "appointment:a1", refundId: "r2", amount: -133.33 }),
    ]);
  });

  it("a visit not paid out, or a refund of points: nothing", async () => {
    const unpaid = db({
      appointment: { id: "a1", professionalId: "p2", commissionPaid: false, commissionAmount: 400 },
      payments: [{ amount: 3000, status: "paid", refunds: [{ amount: 1000 }] }],
    });
    await recordRefundClawbacks(unpaid.db, { tenantId: "t1", refundId: "r2", amount: 1000, appointmentId: "a1", method: "card" });
    expect(unpaid.store.rows).toEqual([]);

    const points = db({ appointment: { id: "a1", professionalId: "p2", commissionPaid: true, commissionAmount: 400 } });
    await recordRefundClawbacks(points.db, { tenantId: "t1", refundId: "r3", amount: 500, appointmentId: "a1", method: "loyalty_points" });
    expect(points.store.rows).toEqual([]);
    expect(points.db.appointment.findFirst).not.toHaveBeenCalled();
  });

  it("clawedBackBySource: what each item's adjustments took back, positive", async () => {
    const store = adjustmentsStore([
      { tenantId: "t1", sourceKey: "sale_line:l1", amount: -100 },
      { tenantId: "t1", sourceKey: "sale_line:l1", amount: -50 },
      { tenantId: "t1", sourceKey: "appointment:a1", amount: -20 },
    ]);
    const out = await clawedBackBySource({ commissionAdjustment: store }, "t1", { appointmentIds: ["a1"], lineIds: ["l1"] });
    expect(out.get("sale_line:l1")).toBe(150);
    expect(out.get("appointment:a1")).toBe(20);
  });
});

describe("commissions with refund adjustments", () => {
  const JAN = new Date("2026-01-10T10:00:00Z");
  const FEB = new Date("2026-02-10T10:00:00Z");

  /** One walk-in line of 30,00 (commission 3,00) paid in January, refunded a third in February. */
  function service() {
    const line = {
      id: "l1",
      createdAt: JAN,
      description: "Corte",
      commissionBaseCents: 3000,
      commissionRate: 10,
      commissionAmount: 300,
      commissionPaid: true,
      professionalId: "p1",
      totalCents: 3000,
      refundedCents: 1000,
    };
    const adjustments = adjustmentsStore([
      {
        id: "adj-1",
        createdAt: FEB,
        tenantId: "t1",
        professionalId: "p1",
        refundId: "r1",
        posSaleLineId: "l1",
        appointmentId: null,
        sourceKey: "sale_line:l1",
        amount: -100,
        settled: false,
        settledAt: null,
      },
    ]);
    const lines = [line];
    const prisma: any = {
      professional: {
        findFirst: jest.fn(async () => ({ id: "p1", firstName: "Ana", lastName: "Pro", commissionRate: 10, isActive: true })),
        findMany: jest.fn(async () => [{ id: "p1", firstName: "Ana", lastName: "Pro", commissionRate: 10, isActive: true }]),
      },
      appointment: {
        findMany: jest.fn(async () => []),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      tenant: { findUnique: jest.fn(async () => ({ timezone: "Europe/Madrid" })) },
      payment: { findMany: jest.fn(async () => []) },
      posSaleLine: {
        findMany: jest.fn(async ({ where }: any) =>
          lines.filter(
            (l) =>
              (where.commissionPaid === undefined || l.commissionPaid === where.commissionPaid) &&
              (where.id?.in === undefined || where.id.in.includes(l.id)) &&
              (where.createdAt?.gte === undefined || (l.createdAt >= where.createdAt.gte && l.createdAt < where.createdAt.lt)),
          ),
        ),
        updateMany: jest.fn(async () => ({ count: 0 })),
      },
      commissionAdjustment: adjustments,
    };
    return { svc: new CommissionsService(prisma), adjustments };
  }

  it("the summary lists it as pending, 'Ajuste por devolución', linked to the refund", async () => {
    const { svc } = service();
    const summary = await svc.getCommissionSummary("t1", "p1");
    expect(summary.appointments).toEqual([
      expect.objectContaining({
        id: "adj-1",
        source: "refund_adjustment",
        refundId: "r1",
        commissionAmount: -100,
        paid: false,
        serviceName: `${REFUND_ADJUSTMENT_LABEL}: Corte`,
      }),
    ]);
    expect(summary.pendingCommission).toBe(-100);
    const all = await svc.getAllCommissionSummaries("t1");
    expect(all[0].pendingCommission).toBe(-100);
  });

  it("the next payout nets it and settles it", async () => {
    const { svc, adjustments } = service();
    const out = await svc.payCommission("t1", "p1", {} as any);
    expect(out.totalAmount).toBe(-100);
    expect(adjustments.rows[0]).toMatchObject({ settled: true });
    expect(adjustments.rows[0].settledAt).toBeInstanceOf(Date);
    expect((await svc.getCommissionSummary("t1", "p1")).pendingCommission).toBe(0);
  });

  it("the payroll report keeps the paid period as paid and shows the adjustment in its own period", async () => {
    const { svc } = service();
    const january = await svc.getPayrollReport("t1", new Date("2026-01-01"), new Date("2026-01-31"));
    expect(january.professionals[0]).toMatchObject({ commission: 300, refundAdjustments: 0, adjustments: [] });

    const february = await svc.getPayrollReport("t1", new Date("2026-02-01"), new Date("2026-02-28"));
    expect(february.professionals[0]).toMatchObject({ commission: -100, refundAdjustments: -100 });
    expect(february.professionals[0].adjustments).toEqual([
      { id: "adj-1", date: FEB, refundId: "r1", amount: -100, label: REFUND_ADJUSTMENT_LABEL },
    ]);
    expect(february.totalPayroll).toBe(-100);
  });
});
