import { Prisma } from "@prisma/client";
import { CommissionsService } from "./commissions.service";
import { DEFAULT_COMMISSION_RATE, effectiveCommissionRate, numberOrNull } from "./commission-rate";

/**
 * A commission rate of 0 is 0 %, whether it arrives as a Prisma Decimal or as
 * a plain number. The service read rates with `rate ? Number(rate) : 10`, so a
 * plain 0 became the 10 % default; only Prisma's Decimal objects (truthy even
 * at 0) hid it.
 */

describe("effectiveCommissionRate", () => {
  it("0 is a rate, as a number, a numeric string or a Decimal", () => {
    expect(effectiveCommissionRate(0, 25)).toBe(0);
    expect(effectiveCommissionRate("0", 25)).toBe(0);
    expect(effectiveCommissionRate(new Prisma.Decimal(0), 25)).toBe(0);
  });

  it("only null and undefined fall through to the next, then the default", () => {
    expect(effectiveCommissionRate(null, undefined, 12.5)).toBe(12.5);
    expect(effectiveCommissionRate(null, undefined)).toBe(DEFAULT_COMMISSION_RATE);
    expect(effectiveCommissionRate()).toBe(10);
  });

  it("numberOrNull: missing or not a number is null", () => {
    expect(numberOrNull(null)).toBeNull();
    expect(numberOrNull(undefined)).toBeNull();
    expect(numberOrNull("")).toBeNull();
    expect(numberOrNull("abc")).toBeNull();
    expect(numberOrNull(0)).toBe(0);
    expect(numberOrNull(new Prisma.Decimal("12.50"))).toBe(12.5);
  });
});

function service(professional: Record<string, unknown>, appointments: Record<string, unknown>[]) {
  const updates: any[] = [];
  const prisma: any = {
    appointment: {
      findFirst: jest.fn(async () => ({ ...appointments[0], professional })),
      findMany: jest.fn(async () => appointments),
      update: jest.fn(async (args: any) => (updates.push(args.data), {})),
    },
    professional: { findFirst: jest.fn(async () => professional) },
  };
  return { svc: new CommissionsService(prisma), updates };
}

const pro = (commissionRate: unknown) => ({ id: "pro-1", firstName: "Ana", lastName: "G", commissionRate });
const apt = (extra: Record<string, unknown> = {}) => ({
  id: "apt-1",
  totalAmount: 50,
  commissionRate: null,
  commissionAmount: null,
  commissionPaid: false,
  scheduledDate: new Date("2026-10-30T10:00:00Z"),
  client: { firstName: "Eva", lastName: "P" },
  service: { name: "Corte" },
  ...extra,
});

describe("CommissionsService with a plain 0", () => {
  it("calculateCommission: a professional at 0 % earns nothing, not the 10 % default", async () => {
    const { svc, updates } = service(pro(0), [apt()]);
    expect(await svc.calculateCommission("t1", { appointmentId: "apt-1" })).toEqual({ commissionRate: 0, commissionAmount: 0 });
    expect(updates[0]).toEqual({ commissionRate: 0, commissionAmount: 0 });
  });

  it("calculateCommission: an appointment at 0 % overrides the professional's rate", async () => {
    const { svc } = service(pro(40), [apt({ commissionRate: 0 })]);
    expect((await svc.calculateCommission("t1", { appointmentId: "apt-1" })).commissionRate).toBe(0);
  });

  it("calculateCommission: no rate anywhere is still the 10 % default", async () => {
    const { svc } = service(pro(null), [apt()]);
    expect(await svc.calculateCommission("t1", { appointmentId: "apt-1" })).toEqual({ commissionRate: 10, commissionAmount: 5 });
  });

  it("calculatePendingCommissions: 0 % from the professional", async () => {
    const { svc, updates } = service(pro(0), [apt()]);
    expect(await svc.calculatePendingCommissions("t1", "pro-1")).toBe(0);
    expect(updates[0].commissionRate).toBe(0);
  });

  it("getCommissionSummary: 0 % rate, and a stored amount of 0 is kept, not recomputed", async () => {
    const { svc } = service(pro(0), [apt(), apt({ id: "apt-2", commissionRate: 20, commissionAmount: 0 })]);
    const summary = await svc.getCommissionSummary("t1", "pro-1");
    expect(summary.appointments.map((a) => [a.commissionRate, a.commissionAmount])).toEqual([
      [0, 0],
      [20, 0],
    ]);
    expect(summary.pendingCommission).toBe(0);
  });
});
