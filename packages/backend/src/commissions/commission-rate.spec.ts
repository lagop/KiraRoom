import { Prisma } from "@prisma/client";
import { CommissionsService } from "./commissions.service";
import { DEFAULT_COMMISSION_RATE, effectiveCommissionRate, numberOrNull } from "./commission-rate";
import { appointmentCommission, commissionCents, snapshotAppointmentCommission } from "./appointment-commission";

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
    tenant: { findUnique: jest.fn(async () => ({ timezone: "Europe/Madrid" })) },
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

describe("appointmentCommission (the snapshot)", () => {
  it("a professional at 0 % earns nothing, not the 10 % default", () => {
    expect(appointmentCommission(apt(), 0)).toEqual({ rate: 0, amount: 0 });
  });

  it("an appointment at 0 % overrides the professional's rate", () => {
    expect(appointmentCommission(apt({ commissionRate: 0 }), 40)).toEqual({ rate: 0, amount: 0 });
  });

  it("no rate anywhere is still the 10 % default", () => {
    expect(appointmentCommission(apt(), null)).toEqual({ rate: 10, amount: 5 });
  });

  it("whole cents, rounded once: 29,95 EUR at 15 % is 4,49 EUR", () => {
    expect(commissionCents(2995, 15)).toBe(449);
    expect(appointmentCommission(apt({ totalAmount: 2995 }), 15).amount).toBe(449);
  });

  it("not paid out: a stored 0 (the old column default) is not a commission, rate x total is", () => {
    expect(appointmentCommission(apt({ commissionAmount: 0 }), 20)).toEqual({ rate: 20, amount: 10 });
    expect(appointmentCommission(apt({ commissionAmount: new Prisma.Decimal(0) }), 20).amount).toBe(10);
  });

  it("not paid out: it follows the total and the appointment's rate when they change", () => {
    // Snapshot taken at 15 % of 60,00; the total is now 50,00.
    expect(appointmentCommission(apt({ totalAmount: 5000, commissionRate: 15, commissionAmount: 900 }), 30)).toEqual({
      rate: 15,
      amount: 750,
    });
  });

  it("paid out: what was paid, never rewritten (a 0 paid stays 0)", () => {
    expect(appointmentCommission(apt({ commissionPaid: true, commissionAmount: 0 }), 20).amount).toBe(0);
    expect(appointmentCommission(apt({ commissionPaid: true, commissionAmount: 420 }), 20).amount).toBe(420);
    // Never worked out (null): computed.
    expect(appointmentCommission(apt({ commissionPaid: true, commissionAmount: null }), 20).amount).toBe(10);
  });
});

describe("snapshotAppointmentCommission", () => {
  function db(row: Record<string, unknown> | null) {
    const writes: any[] = [];
    return {
      writes,
      db: {
        appointment: {
          findFirst: jest.fn(async () => row),
          updateMany: jest.fn(async (args: any) => (writes.push(args), { count: 1 })),
        },
      },
    };
  }
  const done = (extra: Record<string, unknown> = {}) =>
    apt({ status: "completed", paymentStatus: "paid", professional: { commissionRate: 15 }, totalAmount: 6000, ...extra });

  it("completed and paid: stores the rate that applies and the amount, only while not paid out", async () => {
    const t = db(done());
    expect(await snapshotAppointmentCommission(t.db, "t1", "apt-1")).toBe(true);
    expect(t.writes).toEqual([
      { where: { id: "apt-1", tenantId: "t1", commissionPaid: false }, data: { commissionRate: 15, commissionAmount: 900 } },
    ]);
  });

  it("an explicit 0 % stores 0", async () => {
    const t = db(done({ commissionRate: 0 }));
    await snapshotAppointmentCommission(t.db, "t1", "apt-1");
    expect(t.writes[0].data).toEqual({ commissionRate: 0, commissionAmount: 0 });
  });

  it("nothing before it is completed and paid, nothing once paid out, nothing when already up to date", async () => {
    for (const row of [
      done({ paymentStatus: "partially_paid" }),
      done({ status: "in_progress" }),
      done({ commissionPaid: true, commissionAmount: 0 }),
      done({ commissionRate: 15, commissionAmount: 900 }),
      null,
    ]) {
      const t = db(row);
      expect(await snapshotAppointmentCommission(t.db, "t1", "apt-1")).toBe(false);
      expect(t.writes).toEqual([]);
    }
  });
});

describe("CommissionsService: the stored 0 of the old default", () => {
  it("getCommissionSummary: 0 % stays 0; a stored 0 with a rate above 0 is worked out", async () => {
    const { svc } = service(pro(0), [apt(), apt({ id: "apt-2", commissionRate: 20, commissionAmount: 0 })]);
    const summary = await svc.getCommissionSummary("t1", "pro-1");
    expect(summary.appointments.map((a) => [a.commissionRate, a.commissionAmount])).toEqual([
      [0, 0],
      [20, 10],
    ]);
    expect(summary.pendingCommission).toBe(10);
  });

  it("the rows add up to the total: two 29,95 EUR services at 15 % are 4,49 + 4,49 = 8,98", async () => {
    const { svc } = service(pro(15), [apt({ totalAmount: 2995 }), apt({ id: "apt-2", totalAmount: 2995 })]);
    const summary = await svc.getCommissionSummary("t1", "pro-1");
    expect(summary.appointments.map((a) => a.commissionAmount)).toEqual([449, 449]);
    expect(summary.pendingCommission).toBe(898);
  });
});
