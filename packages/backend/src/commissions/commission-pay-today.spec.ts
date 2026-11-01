import { ConflictException } from "@nestjs/common";
import { CommissionsService } from "./commissions.service";

/**
 * "Pagar" in the commissions summary pays exactly what its dialog shows:
 * everything pending for the professional up to the end of today on the
 * salon's clock, refund adjustments included, whatever dates the payroll tab
 * has. It used to send the payroll tab's range, so the dialog said one
 * amount (all pending) and a different one was paid (that range's).
 */

type Row = Record<string, any>;

function inRange(value: Date, f: any): boolean {
  if (!f) return true;
  if (f.gte && value < f.gte) return false;
  if (f.lt && value >= f.lt) return false;
  return true;
}

function matches(row: Row, where: Row, dateField: string): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (key === dateField) return inRange(row[key], cond);
    if (cond && typeof cond === "object" && "in" in cond) return (cond.in as unknown[]).includes(row[key]);
    if (cond && typeof cond === "object" && "not" in cond) return row[key] !== cond.not;
    return row[key] === cond;
  });
}

// Today: Monday 2 November 2026, 12:00 in Madrid.
const NOW = new Date("2026-11-02T11:00:00Z");

function setup() {
  const appointments: Row[] = [
    // Last month: the payroll tab's default range (this month) left it out.
    { id: "a-oct", tenantId: "t1", professionalId: "p1", status: "completed", paymentStatus: "paid", scheduledDate: new Date("2026-10-15T00:00:00Z"), totalAmount: 5000, commissionRate: 10, commissionAmount: 500, commissionPaid: false, client: { firstName: "Ana", lastName: "L" }, service: { name: "Color" } },
    // Today, no stored amount: 10 % of 40,00 €, partly refunded (a quarter back).
    { id: "a-today", tenantId: "t1", professionalId: "p1", status: "completed", paymentStatus: "paid", scheduledDate: new Date("2026-11-02T00:00:00Z"), totalAmount: 4000, commissionRate: null, commissionAmount: null, commissionPaid: false, client: { firstName: "Eva", lastName: "R" }, service: { name: "Mechas" } },
    // Tomorrow's: not due today.
    { id: "a-tomorrow", tenantId: "t1", professionalId: "p1", status: "completed", paymentStatus: "paid", scheduledDate: new Date("2026-11-03T00:00:00Z"), totalAmount: 9000, commissionRate: 10, commissionAmount: 900, commissionPaid: false, client: { firstName: "Sol", lastName: "M" }, service: { name: "Corte" } },
    // Another professional's.
    { id: "a-other", tenantId: "t1", professionalId: "p2", status: "completed", paymentStatus: "paid", scheduledDate: new Date("2026-11-01T00:00:00Z"), totalAmount: 3000, commissionRate: 10, commissionAmount: 300, commissionPaid: false, client: { firstName: "X", lastName: "Y" }, service: { name: "Corte" } },
  ];
  const lines: Row[] = [
    // Sold at the till late today (23:30 in Madrid is still today).
    { id: "l-today", tenantId: "t1", professionalId: "p1", kind: "service", createdAt: new Date("2026-11-02T22:30:00Z"), description: "Peinado", commissionBaseCents: 2000, commissionRate: 10, commissionAmount: 200, commissionPaid: false, totalCents: 2000, refundedCents: 0 },
    // 00:30 tomorrow in Madrid: not today.
    { id: "l-tomorrow", tenantId: "t1", professionalId: "p1", kind: "service", createdAt: new Date("2026-11-02T23:30:00Z"), description: "Corte", commissionBaseCents: 3000, commissionRate: 10, commissionAmount: 300, commissionPaid: false, totalCents: 3000, refundedCents: 0 },
  ];
  const adjustments: Row[] = [
    // A refund after an earlier payout took 1,50 € back (#217).
    { id: "adj-1", tenantId: "t1", professionalId: "p1", refundId: "r1", appointmentId: null, posSaleLineId: "l-old", amount: -150, settled: false, settledAt: null, createdAt: new Date("2026-10-20T10:00:00Z") },
  ];
  const store = (rows: Row[], dateField: string) => ({
    findMany: jest.fn(async ({ where }: any) => rows.filter((r) => matches(r, where, dateField))),
    updateMany: jest.fn(async ({ where, data }: any) => {
      const hit = rows.filter((r) => matches(r, where, dateField));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
  });
  const prisma: any = {
    tenant: { findUnique: jest.fn(async () => ({ timezone: "Europe/Madrid" })) },
    professional: {
      findFirst: jest.fn(async ({ where }: any) => (where.id === "p1" ? { id: "p1", firstName: "Lucía", lastName: "M", commissionRate: 10, isActive: true } : null)),
      findMany: jest.fn(async () => [{ id: "p1", firstName: "Lucía", lastName: "M", commissionRate: 10, isActive: true }]),
    },
    appointment: store(appointments, "scheduledDate"),
    posSaleLine: store(lines, "createdAt"),
    commissionAdjustment: store(adjustments, "createdAt"),
    payment: {
      findMany: jest.fn(async () => [{ appointmentId: "a-today", amount: 4000, status: "paid", refunds: [{ amount: 1000 }] }]),
    },
  };
  const svc = new CommissionsService(prisma);
  return { svc, appointments, lines, adjustments };
}

describe("Pagar pays exactly what the dialog shows", () => {
  it("the summary's pending figure: everything up to the end of today, adjustments included", async () => {
    const { svc } = setup();
    const summary = await svc.getCommissionSummary("t1", "p1", NOW);
    // 500 (October) + 300 (today's 400 x 0,75 kept) + 200 (till, today) - 150 (adjustment)
    expect(summary.pendingCommission).toBe(850);
    expect(summary.pendingUpTo).toBe("2026-11-02");
    expect(summary.appointments.map((e) => e.id).sort()).toEqual(["a-oct", "a-today", "adj-1", "l-today"]);
    const all = await svc.getAllCommissionSummaries("t1", NOW);
    expect(all[0].pendingCommission).toBe(850);
  });

  it("pays that figure and marks exactly those items, whatever the payroll tab's range was", async () => {
    const { svc, appointments, lines, adjustments } = setup();
    const shown = (await svc.getCommissionSummary("t1", "p1", NOW)).pendingCommission;

    const out = await svc.payCommission("t1", "p1", { expectedAmount: shown }, NOW);

    expect(out).toEqual({ count: 4, totalAmount: shown });
    const paid = (id: string) => appointments.find((a) => a.id === id)!.commissionPaid;
    expect(paid("a-oct")).toBe(true);
    expect(paid("a-today")).toBe(true);
    expect(paid("a-tomorrow")).toBe(false);
    expect(paid("a-other")).toBe(false);
    expect(lines.find((l) => l.id === "l-today")!.commissionPaid).toBe(true);
    expect(lines.find((l) => l.id === "l-tomorrow")!.commissionPaid).toBe(false);
    expect(adjustments[0]).toMatchObject({ settled: true });
    expect(adjustments[0].settledAt).toBeInstanceOf(Date);

    // Nothing pending left up to today; tomorrow's work waits for tomorrow.
    expect((await svc.getCommissionSummary("t1", "p1", NOW)).pendingCommission).toBe(0);
    const tomorrow = await svc.getCommissionSummary("t1", "p1", new Date("2026-11-03T11:00:00Z"));
    expect(tomorrow.pendingCommission).toBe(900 + 300);
  });

  it("refuses, paying nothing, when what is pending is no longer what the dialog showed", async () => {
    const { svc, appointments, adjustments } = setup();
    const shown = (await svc.getCommissionSummary("t1", "p1", NOW)).pendingCommission;
    // A new adjustment arrives while the dialog is open.
    adjustments.push({ id: "adj-2", tenantId: "t1", professionalId: "p1", refundId: "r2", appointmentId: null, posSaleLineId: "l-x", amount: -50, settled: false, settledAt: null, createdAt: new Date("2026-11-02T10:30:00Z") });

    await expect(svc.payCommission("t1", "p1", { expectedAmount: shown }, NOW)).rejects.toBeInstanceOf(ConflictException);
    await expect(svc.payCommission("t1", "p1", { expectedAmount: shown }, NOW)).rejects.toThrow(/8,00\s€/);
    expect(appointments.every((a) => a.commissionPaid === false)).toBe(true);
    expect(adjustments.every((a) => a.settled === false)).toBe(true);
  });

  it("a negative balance (only an adjustment pending) is paid as shown too", async () => {
    const { svc, appointments, lines, adjustments } = setup();
    appointments.forEach((a) => (a.commissionPaid = true));
    lines.forEach((l) => (l.commissionPaid = true));
    const shown = (await svc.getCommissionSummary("t1", "p1", NOW)).pendingCommission;
    expect(shown).toBe(-150);
    expect(await svc.payCommission("t1", "p1", { expectedAmount: -150 }, NOW)).toEqual({ count: 1, totalAmount: -150 });
    expect(adjustments[0].settled).toBe(true);
  });
});
