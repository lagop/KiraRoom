import { commissionPeriodFilters, periodDay } from "./commission-period";
import { CommissionsService } from "./commissions.service";

/**
 * Payroll and payout periods include their last day, whole, in the salon's
 * timezone. They used to stop at 00:00 UTC of the end day.
 */
describe("commission periods", () => {
  it("reads the calendar day of a bound", () => {
    expect(periodDay("2026-11-30")).toBe("2026-11-30");
    expect(periodDay(new Date("2026-11-30"))).toBe("2026-11-30");
    expect(periodDay("2026-11-30T15:00:00.000Z")).toBe("2026-11-30");
    expect(periodDay("")).toBeNull();
    expect(periodDay(undefined)).toBeNull();
    expect(periodDay("nope")).toBeNull();
    expect(periodDay(new Date("nope"))).toBeNull();
  });

  it("appointments: the end day is included (scheduledDate is the day at 00:00 UTC)", () => {
    const f = commissionPeriodFilters("2026-11-01", "2026-11-30", "Europe/Madrid");
    expect(f.scheduledDate).toEqual({
      gte: new Date("2026-11-01T00:00:00.000Z"),
      lt: new Date("2026-12-01T00:00:00.000Z"),
    });
  });

  it("sale lines and adjustments: whole salon days, Madrid winter time", () => {
    const f = commissionPeriodFilters(new Date("2026-11-01"), new Date("2026-11-30"), "Europe/Madrid");
    // Madrid is UTC+1 in November: the 1st starts at 23:00 UTC the day before.
    expect(f.createdAt).toEqual({
      gte: new Date("2026-10-31T23:00:00.000Z"),
      lt: new Date("2026-11-30T23:00:00.000Z"),
    });
    const lateOnLastDay = new Date("2026-11-30T22:30:00.000Z"); // 23:30 in Madrid
    expect(lateOnLastDay < f.createdAt!.lt!).toBe(true);
  });

  it("summer time and other zones", () => {
    expect(commissionPeriodFilters("2026-07-01", "2026-07-31", "Europe/Madrid").createdAt).toEqual({
      gte: new Date("2026-06-30T22:00:00.000Z"),
      lt: new Date("2026-07-31T22:00:00.000Z"),
    });
    expect(commissionPeriodFilters("2026-11-01", "2026-11-30", "Atlantic/Canary").createdAt).toEqual({
      gte: new Date("2026-11-01T00:00:00.000Z"),
      lt: new Date("2026-12-01T00:00:00.000Z"),
    });
  });

  it("one end open, reversed ends, no ends", () => {
    expect(commissionPeriodFilters(undefined, "2026-11-30", "Europe/Madrid")).toEqual({
      scheduledDate: { lt: new Date("2026-12-01T00:00:00.000Z") },
      createdAt: { lt: new Date("2026-11-30T23:00:00.000Z") },
    });
    expect(commissionPeriodFilters("2026-11-01", undefined, "Europe/Madrid")).toEqual({
      scheduledDate: { gte: new Date("2026-11-01T00:00:00.000Z") },
      createdAt: { gte: new Date("2026-10-31T23:00:00.000Z") },
    });
    expect(commissionPeriodFilters("2026-11-30", "2026-11-01", "Europe/Madrid")).toEqual(
      commissionPeriodFilters("2026-11-01", "2026-11-30", "Europe/Madrid"),
    );
    expect(commissionPeriodFilters(undefined, undefined, "Europe/Madrid")).toEqual({});
  });
});

describe("CommissionsService periods", () => {
  const LAST_DAY_VISIT = {
    id: "a1",
    tenantId: "t1",
    professionalId: "p1",
    scheduledDate: new Date("2026-11-30T00:00:00.000Z"),
    status: "completed",
    paymentStatus: "paid",
    totalAmount: 5000,
    commissionAmount: 500,
    commissionRate: 10,
    commissionPaid: false,
    professional: { id: "p1" },
  };
  const LAST_DAY_SALE = {
    id: "l1",
    tenantId: "t1",
    professionalId: "p1",
    kind: "service",
    createdAt: new Date("2026-11-30T22:30:00.000Z"), // 23:30 in Madrid, the last day
    commissionBaseCents: 3000,
    commissionAmount: 300,
    commissionRate: 10,
    commissionPaid: false,
    totalCents: 3000,
    refundedCents: 0,
  };
  const LAST_DAY_ADJUSTMENT = {
    id: "adj-1",
    tenantId: "t1",
    professionalId: "p1",
    refundId: "r1",
    appointmentId: null,
    posSaleLineId: "l0",
    sourceKey: "sale_line:l0",
    createdAt: new Date("2026-11-30T21:00:00.000Z"),
    amount: -100,
    settled: false,
    settledAt: null,
  };

  /** A filter on one Date column, as Prisma reads it. */
  function inRange(value: Date, f: any): boolean {
    if (!f) return true;
    if (f.gte && value < f.gte) return false;
    if (f.gt && value <= f.gt) return false;
    if (f.lt && value >= f.lt) return false;
    if (f.lte && value > f.lte) return false;
    return true;
  }

  function service() {
    const where: Record<string, any[]> = { appointment: [], posSaleLine: [], commissionAdjustment: [] };
    const store = (name: string, rows: any[], dateField: string) => {
      const match = (w: any) => rows.filter((r) => inRange(r[dateField], w[dateField]));
      return {
        findMany: jest.fn(async ({ where: w }: any) => {
          where[name].push(w);
          return match(w);
        }),
        updateMany: jest.fn(async ({ where: w }: any) => ({ count: match(w).length })),
      };
    };
    const prisma: any = {
      tenant: { findUnique: jest.fn(async () => ({ timezone: "Europe/Madrid" })) },
      professional: {
        findMany: jest.fn(async () => [{ id: "p1", firstName: "Ana", lastName: "Pro", commissionRate: 10, isActive: true }]),
      },
      payment: { findMany: jest.fn(async () => []) },
      refund: { findMany: jest.fn(async () => []) },
      appointment: store("appointment", [LAST_DAY_VISIT], "scheduledDate"),
      posSaleLine: store("posSaleLine", [LAST_DAY_SALE], "createdAt"),
      commissionAdjustment: store("commissionAdjustment", [LAST_DAY_ADJUSTMENT], "createdAt"),
    };
    return { svc: new CommissionsService(prisma), where, prisma };
  }

  it("the payroll counts the visit, the sale and the adjustment of the last day", async () => {
    const { svc, where } = service();
    const report = await svc.getPayrollReport("t1", "2026-11-01", "2026-11-30");
    expect(report.period).toEqual({ start: "2026-11-01", end: "2026-11-30" });
    expect(report.professionals[0]).toMatchObject({
      totalSales: 8000,
      commission: 500 + 300 - 100,
      refundAdjustments: -100,
    });
    expect(where.appointment[0].scheduledDate).toEqual({
      gte: new Date("2026-11-01T00:00:00.000Z"),
      lt: new Date("2026-12-01T00:00:00.000Z"),
    });
    for (const w of [...where.posSaleLine, ...where.commissionAdjustment]) {
      expect(w.createdAt).toEqual({
        gte: new Date("2026-10-31T23:00:00.000Z"),
        lt: new Date("2026-11-30T23:00:00.000Z"),
      });
    }
  });

  it("the payroll as the controller calls it: Dates from bare days", async () => {
    const { svc } = service();
    const report = await svc.getPayrollReport("t1", new Date("2026-11-01"), new Date("2026-11-30"));
    expect(report.professionals[0].commission).toBe(700);
    const before = await svc.getPayrollReport("t1", "2026-11-01", "2026-11-29");
    expect(before.professionals[0]).toMatchObject({ totalSales: 0, commission: 0 });
  });

  it("the payroll refuses a missing date instead of failing in the database", async () => {
    const { svc } = service();
    await expect(svc.getPayrollReport("t1", "", "2026-11-30")).rejects.toThrow("startDate and endDate");
  });

  it("the payout pays the last day too, by the same filters", async () => {
    const { svc, where } = service();
    const out = await svc.payCommission("t1", "p1", {
      startDate: new Date("2026-11-01"),
      endDate: new Date("2026-11-30"),
    });
    expect(out).toEqual({ count: 3, totalAmount: 500 + 300 - 100 });
    expect(where.appointment[0].scheduledDate.lt).toEqual(new Date("2026-12-01T00:00:00.000Z"));
    expect(where.posSaleLine[0].createdAt.lt).toEqual(new Date("2026-11-30T23:00:00.000Z"));
    expect(where.commissionAdjustment[0].createdAt.lt).toEqual(new Date("2026-11-30T23:00:00.000Z"));
  });

  it("a payout without dates does not look the salon up", async () => {
    const { svc, prisma } = service();
    const out = await svc.payCommission("t1", "p1", {});
    expect(out.count).toBe(3);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });
});
