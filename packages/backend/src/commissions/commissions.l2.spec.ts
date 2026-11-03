import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { ConflictException } from "@nestjs/common";
import { AppointmentsService } from "../appointments/appointments.service";
import { PosService } from "../pos/pos.service";
import { WalletService } from "../payments/services/wallet.service";
import { CommissionsService } from "./commissions.service";

/**
 * L2: appointment commissions through the real flow, against a real
 * database (panel audit K1, K3, K4, K6).
 *
 *   - A visit booked from the panel, completed and charged at the till
 *     earns its professional's rate: the snapshot is stored on it when it is
 *     completed and paid (appointment-commission.ts). It used to keep the
 *     column's default 0 and earn nothing.
 *   - An explicit 0 % on the appointment earns 0; the rate is fixed once
 *     the visit is done (changing the professional's rate later does not
 *     rewrite it).
 *   - The payroll report counts paid visits only, like "Pagar".
 *   - A deactivated professional with something pending still shows ("De
 *     baja") and can be paid.
 *   - Two "Pagar" at once: one pays, the other gets a 409.
 *
 * Skipped when no database is reachable, so `npm test` stays green on a
 * workstation without Postgres. CI provides one.
 */
const prisma = new PrismaClient();
const db: any = prisma;
let reachable = false;
let tenantId: string;
let serviceId: string;
let clientId: string;
let agenda: AppointmentsService;
let pos: PosService;
let commissions: CommissionsService;
const run = randomUUID().slice(0, 8);
const OWNER: any = { id: "l2-owner", role: "owner" };

// Booked for tomorrow (a booking cannot be in the past); read and paid as of the day after.
const tomorrow = new Date(Date.now() + 864e5).toISOString().slice(0, 10);
const later = new Date(Date.now() + 3 * 864e5);
const reportFrom = new Date(Date.now() - 864e5);
let slot = 8;

beforeAll(async () => {
  try {
    await prisma.$connect();
    reachable = true;
  } catch (e) {
    console.error("[l2] database unreachable, skipping:", (e as Error).message.slice(0, 160));
    return;
  }
  const tenant = await db.tenant.create({
    data: {
      name: "L2 commissions",
      slug: `l2-commissions-${run}`,
      plan: "pro",
      subscriptionStatus: "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 864e5),
      fiscalSettings: { pricesIncludeTax: true, defaultTaxRate: 21, defaultSeries: "A" },
    },
  });
  tenantId = tenant.id;
  OWNER.tenantId = tenantId;
  serviceId = (await db.service.create({ data: { tenantId, name: "Color", category: "hair", duration: 30, price: 60 } })).id;
  clientId = (await db.client.create({ data: { tenantId, firstName: "Ana", lastName: "Prueba" } })).id;

  const stub = {} as any;
  const consent: any = { hasValidConsent: jest.fn(async () => true), getRequiredForms: jest.fn(async () => []) };
  agenda = new AppointmentsService(db, stub, stub, stub, stub, stub, stub, consent);
  // Notices are not what this is about.
  (agenda as any).sendAppointmentCreatedNotifications = jest.fn(async () => ({ emailSent: false, smsSent: false }));
  (agenda as any).sendAppointmentCompletedNotifications = jest.fn(async () => undefined);
  (agenda as any).events = { recordOnce: jest.fn(), record: jest.fn() };
  pos = new PosService(db, new WalletService(db));
  commissions = new CommissionsService(db);
}, 60_000);

afterAll(async () => {
  if (reachable && tenantId) {
    const where = { tenantId };
    await db.payment.deleteMany({ where }).catch(() => undefined);
    await db.appointmentActivity.deleteMany({ where: { appointment: where } }).catch(() => undefined);
    await db.appointment.deleteMany({ where }).catch(() => undefined);
    await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

const newPro = async (commissionRate: number | null) =>
  (
    await db.professional.create({
      data: {
        tenantId,
        firstName: "Pro",
        lastName: randomUUID().slice(0, 6),
        email: `pro-${randomUUID().slice(0, 8)}@example.test`,
        hireDate: new Date(),
        commissionRate,
      },
    })
  ).id as string;

/** Booked from the panel by the owner, as the agenda does. */
const book = async (professionalId: string, extra: Record<string, unknown> = {}) =>
  agenda.createByStaff(
    {
      professionalId,
      serviceId,
      clientId,
      scheduledDate: tomorrow,
      scheduledTime: `${String(slot++).padStart(2, "0")}:00`,
      allowOutsideHours: true,
      ...extra,
    } as any,
    OWNER,
  );

/** Charged in full at the till, by card. */
const charge = (appointmentId: string) =>
  pos.processCheckout({
    tenantId,
    actor: OWNER,
    clientId,
    appointmentIds: [appointmentId],
    payments: [{ method: "card", amount: 6000 }],
  } as any);

const row = (id: string) => db.appointment.findUnique({ where: { id } });

describe("appointment commissions (L2, real database)", () => {
  it("booked, completed and charged: it earns its professional's 15 %, stored on it, and Pagar pays it", async () => {
    if (!reachable) return;
    const pro = await newPro(15);
    const apt: any = await book(pro);
    // Nothing worked out at booking: null, not the old default 0.
    expect((await row(apt.id)).commissionAmount).toBeNull();

    await agenda.complete(OWNER, apt.id);
    expect((await row(apt.id)).commissionAmount).toBeNull(); // completed, not paid yet
    await charge(apt.id);
    const done = await row(apt.id);
    expect(done).toMatchObject({ status: "completed", paymentStatus: "paid", commissionPaid: false });
    expect(Number(done.commissionRate)).toBe(15);
    expect(Number(done.commissionAmount)).toBe(900);

    const summary = await commissions.getCommissionSummary(tenantId, pro, later);
    expect(summary.appointments).toEqual([
      expect.objectContaining({ id: apt.id, source: "appointment", amount: 6000, commissionRate: 15, commissionAmount: 900 }),
    ]);
    expect(summary.pendingCommission).toBe(900);

    const report = await commissions.getPayrollReport(tenantId, reportFrom, later);
    expect(report.professionals.find((p) => p.id === pro)).toMatchObject({ totalSales: 6000, commission: 900 });

    // The professional's rate changes afterwards: the visit keeps the one it was done with.
    await db.professional.update({ where: { id: pro }, data: { commissionRate: 30 } });
    expect((await commissions.getCommissionSummary(tenantId, pro, later)).pendingCommission).toBe(900);

    expect(await commissions.payCommission(tenantId, pro, { expectedAmount: 900 } as any, later)).toEqual({
      count: 1,
      totalAmount: 900,
    });
    const paid = await row(apt.id);
    expect(paid.commissionPaid).toBe(true);
    expect(Number(paid.commissionAmount)).toBe(900);
  }, 60_000);

  it("an explicit 0 % on the appointment earns 0, stored as 0", async () => {
    if (!reachable) return;
    const pro = await newPro(15);
    const apt: any = await book(pro, { commissionRate: 0 });
    await agenda.complete(OWNER, apt.id);
    await charge(apt.id);
    const done = await row(apt.id);
    expect(Number(done.commissionRate)).toBe(0);
    expect(Number(done.commissionAmount)).toBe(0);
    expect((await commissions.getCommissionSummary(tenantId, pro, later)).pendingCommission).toBe(0);
  }, 60_000);

  it("the payroll report counts paid visits only, as Pagar does", async () => {
    if (!reachable) return;
    const pro = await newPro(15);
    const apt: any = await book(pro);
    await agenda.complete(OWNER, apt.id);
    const report = await commissions.getPayrollReport(tenantId, reportFrom, later);
    expect(report.professionals.find((p) => p.id === pro)).toMatchObject({ totalSales: 0, commission: 0 });
  }, 60_000);

  it("a deactivated professional with something pending still shows, 'De baja', and can be paid", async () => {
    if (!reachable) return;
    const pro = await newPro(10);
    const apt: any = await book(pro);
    await agenda.complete(OWNER, apt.id);
    await charge(apt.id);
    await db.professional.update({ where: { id: pro }, data: { isActive: false } });

    const all = await commissions.getAllCommissionSummaries(tenantId, later);
    expect(all.find((s) => s.professionalId === pro)).toMatchObject({ isActive: false, pendingCommission: 600 });
    const report = await commissions.getPayrollReport(tenantId, reportFrom, later);
    expect(report.professionals.find((p) => p.id === pro)).toMatchObject({ isActive: false, commission: 600 });

    await commissions.payCommission(tenantId, pro, { expectedAmount: 600 } as any, later);
    // Nothing pending any more: no longer listed in the summary.
    expect((await commissions.getAllCommissionSummaries(tenantId, later)).some((s) => s.professionalId === pro)).toBe(false);
  }, 60_000);

  it("two Pagar at once for the same professional: one pays, the other gets a 409, paid once", async () => {
    if (!reachable) return;
    const pro = await newPro(15);
    const apt: any = await book(pro);
    await agenda.complete(OWNER, apt.id);
    await charge(apt.id);

    const results = await Promise.allSettled([
      commissions.payCommission(tenantId, pro, { expectedAmount: 900 } as any, later),
      commissions.payCommission(tenantId, pro, { expectedAmount: 900 } as any, later),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>[];
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(ok[0].value).toEqual({ count: 1, totalAmount: 900 });
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(ConflictException);
    expect((await row(apt.id)).commissionPaid).toBe(true);
  }, 60_000);
});
