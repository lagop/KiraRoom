import { ConflictException } from "@nestjs/common";
import { CommissionsService } from "./commissions.service";

/**
 * Commissions phase 2: the payroll CSV (csv-cell.ts escaping) and
 * "Deshacer último pago" (exactly the payout's items, clawbacks of refunds
 * given after it removed, audit-logged). The real-database flow is in
 * commissions.l2.spec.ts.
 */

describe("payroll CSV", () => {
  it("escapes text cells, writes euros with a decimal comma, and adds the BOM", async () => {
    const svc = new CommissionsService({} as any);
    jest.spyOn(svc, "getPayrollReport").mockResolvedValue({
      period: { start: "2026-11-01", end: "2026-11-30" },
      totalPayroll: 12345,
      professionals: [
        {
          id: "p1",
          name: "=SUM(1)",
          isActive: true,
          totalHours: 0,
          totalSales: 100000,
          productSales: 2000,
          commission: 12345,
          refundAdjustments: -150,
          adjustments: [],
          paid: 10000,
        },
        {
          id: "p2",
          name: "Ana; López",
          isActive: false,
          totalHours: 0,
          totalSales: 0,
          productSales: 0,
          commission: 0,
          refundAdjustments: 0,
          adjustments: [],
          paid: 0,
        },
      ],
      unassignedServices: { count: 2, totalSales: 5000 },
    });
    const { filename, csv } = await svc.getPayrollCsv("t1", "2026-11-01", "2026-11-30");
    expect(filename).toBe("comisiones_2026-11-01_2026-11-30.csv");
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    const rows = csv.slice(1).split("\r\n");
    expect(rows[0]).toBe(
      "Profesional;Estado;Ventas;De ellas, productos;Ajustes por devolución;Comisión;Pagado en el periodo;% sobre ventas",
    );
    // A name a spreadsheet would run is text; a ";" inside a name is quoted.
    expect(rows[1]).toBe(`"'=SUM(1)";Activa;1000,00;20,00;-1,50;123,45;100,00;12,3`);
    expect(rows[2]).toBe(`"Ana; López";De baja;0,00;0,00;0,00;0,00;0,00;0,0`);
    expect(rows[3]).toBe("Servicios sin profesional;2 sin asignar;50,00;;;;;");
    expect(rows[4]).toBe("Total;;;;;123,45;;");
  });
});

describe("Deshacer último pago", () => {
  const PAYOUT = {
    id: "po-2",
    tenantId: "t1",
    professionalId: "p1",
    amountCents: 700,
    itemCount: 3,
    upTo: new Date("2026-11-30T00:00:00Z"),
    createdAt: new Date("2026-11-30T18:00:00Z"),
    undoneAt: null,
    items: {
      appointments: [{ id: "a1", rate: 15, amount: 900, prevRate: 15, prevAmount: 900 }],
      lines: ["l1"],
      adjustments: ["adj-settled"],
    },
  };

  function setup(opts: { latest?: string; payout?: any } = {}) {
    const calls: Record<string, any[]> = {};
    const log = (name: string) =>
      jest.fn(async (args: any) => {
        (calls[name] ??= []).push(args);
        return { count: 1 };
      });
    const payout = opts.payout ?? PAYOUT;
    const tx: any = {
      $executeRaw: jest.fn(async () => 0),
      commissionPayout: {
        findFirst: jest.fn(async ({ where }: any) =>
          where.id ? payout : { id: opts.latest ?? payout.id },
        ),
        update: log("payout.update"),
      },
      appointment: { updateMany: log("appointment.updateMany") },
      posSaleLine: { updateMany: log("line.updateMany") },
      commissionAdjustment: {
        updateMany: log("adjustment.updateMany"),
        findMany: jest.fn(async (args: any) => {
          (calls["adjustment.findMany"] ??= []).push(args);
          return [{ id: "adj-late", refundId: "r9", sourceKey: "appointment:a1", amount: "-300" }];
        }),
        deleteMany: log("adjustment.deleteMany"),
      },
    };
    const prisma: any = {
      commissionPayout: { findFirst: jest.fn(async () => payout) },
      $transaction: (fn: any) => fn(tx),
    };
    const audit = { record: jest.fn(async () => ({ id: "log" })) };
    return { svc: new CommissionsService(prisma, audit as any), calls, audit };
  }

  it("unmarks exactly its items, re-opens what it settled, removes later clawbacks, audit-logged", async () => {
    const { svc, calls, audit } = setup();
    await svc.undoPayout("t1", "po-2", { id: "u-owner", role: "owner" });

    expect(calls["appointment.updateMany"]).toEqual([
      {
        where: { tenantId: "t1", professionalId: "p1", id: { in: ["a1"] }, commissionPaid: true },
        data: { commissionPaid: false, commissionDate: null, commissionRate: 15, commissionAmount: 900 },
      },
    ]);
    expect(calls["line.updateMany"]).toEqual([
      {
        where: { tenantId: "t1", professionalId: "p1", id: { in: ["l1"] }, commissionPaid: true },
        data: { commissionPaid: false, commissionDate: null },
      },
    ]);
    expect(calls["adjustment.updateMany"]).toEqual([
      {
        where: { tenantId: "t1", professionalId: "p1", id: { in: ["adj-settled"] }, settled: true },
        data: { settled: false, settledAt: null },
      },
    ]);
    // The clawbacks of refunds given after the payout on its own items, not settled.
    expect(calls["adjustment.findMany"][0].where).toEqual({
      tenantId: "t1",
      professionalId: "p1",
      sourceKey: { in: ["appointment:a1", "sale_line:l1"] },
      settled: false,
      createdAt: { gte: PAYOUT.createdAt },
      id: { notIn: ["adj-settled"] },
    });
    expect(calls["adjustment.deleteMany"]).toEqual([{ where: { tenantId: "t1", id: { in: ["adj-late"] } } }]);
    expect(calls["payout.update"][0]).toMatchObject({ where: { id: "po-2" }, data: { undoneById: "u-owner" } });
    expect(audit.record).toHaveBeenCalledWith(
      "commission.payout.undone",
      expect.objectContaining({
        actorId: "u-owner",
        tenantId: "t1",
        metadata: expect.objectContaining({
          payoutId: "po-2",
          amountCents: 700,
          removedAdjustments: [{ id: "adj-late", refundId: "r9", sourceKey: "appointment:a1", amount: -300 }],
        }),
      }),
      expect.anything(),
    );
  });

  it("only the professional's latest payout", async () => {
    const { svc, calls } = setup({ latest: "po-3" });
    await expect(svc.undoPayout("t1", "po-2", { id: "u", role: "owner" })).rejects.toBeInstanceOf(ConflictException);
    expect(calls["appointment.updateMany"]).toBeUndefined();
  });

  it("not twice", async () => {
    const { svc } = setup({ payout: { ...PAYOUT, undoneAt: new Date() } });
    await expect(svc.undoPayout("t1", "po-2", { id: "u", role: "owner" })).rejects.toBeInstanceOf(ConflictException);
  });
});
