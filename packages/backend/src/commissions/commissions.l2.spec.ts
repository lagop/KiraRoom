import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { ConflictException } from "@nestjs/common";
import { AppointmentsService } from "../appointments/appointments.service";
import { PosService } from "../pos/pos.service";
import { WalletService } from "../payments/services/wallet.service";
import { CommissionsService } from "./commissions.service";
import { AuditLogService } from "../saas/audit-log.service";

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
 *   - Phase 2: "Pagar" records a payout (the "Pagado" figure, the "Pagos"
 *     tab), "Deshacer último pago" unmarks exactly its items (only the
 *     latest, audit-logged), "Pagar hasta" pays up to a day, products earn
 *     the product rate, and the salon's "Comisión por defecto" and
 *     "Comisión sobre" apply.
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
let ownerUser: string;
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
      // On the price with the tax: the figures below are rate x 60,00.
      commissionBase: "gross",
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
  ownerUser = (
    await db.user.create({
      data: {
        tenantId,
        email: `l2-comm-owner-${run}@example.test`,
        firstName: "Dueña",
        lastName: "L2",
        role: "owner",
        passwordHash: "not-a-real-hash",
      },
    })
  ).id;
  commissions = new CommissionsService(db, new AuditLogService(db));
}, 60_000);

afterAll(async () => {
  if (reachable && tenantId) {
    const where = { tenantId };
    await db.payment.deleteMany({ where }).catch(() => undefined);
    await db.commissionPayout.deleteMany({ where }).catch(() => undefined);
    await db.auditLog.deleteMany({ where }).catch(() => undefined);
    await db.appointmentActivity.deleteMany({ where: { appointment: where } }).catch(() => undefined);
    await db.appointment.deleteMany({ where }).catch(() => undefined);
    await db.user.deleteMany({ where }).catch(() => undefined);
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

    expect(await commissions.payCommission(tenantId, pro, { expectedAmount: 900 } as any, later)).toMatchObject({
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
    expect(ok[0].value).toMatchObject({ count: 1, totalAmount: 900 });
    expect(refused).toHaveLength(1);
    expect(refused[0].reason).toBeInstanceOf(ConflictException);
    expect((await row(apt.id)).commissionPaid).toBe(true);
  }, 60_000);

  it("Pagar records a payout: Pagado, the Pagos tab, and Deshacer último pago unmarks exactly its items", async () => {
    if (!reachable) return;
    const owner = { id: ownerUser, role: "owner" };
    const pro = await newPro(15);
    const first: any = await book(pro);
    await agenda.complete(OWNER, first.id);
    await charge(first.id);
    const paid1 = await commissions.payCommission(tenantId, pro, { expectedAmount: 900 } as any, later, owner);
    expect(paid1.payoutId).toEqual(expect.any(String));

    const second: any = await book(pro);
    await agenda.complete(OWNER, second.id);
    await charge(second.id);
    const before = await row(second.id);
    const paid2 = await commissions.payCommission(tenantId, pro, { expectedAmount: 900 } as any, later, owner);

    // "Pagado" (this month's payouts) and the history: the latest one can be undone.
    const summary = await commissions.getCommissionSummary(tenantId, pro, new Date());
    expect(summary.paidCommission).toBe(1800);
    const payouts = await commissions.listPayouts(tenantId, { professionalId: pro });
    expect(payouts.map((p) => [p.id, p.amountCents, p.itemCount, p.canUndo, p.createdByName])).toEqual([
      [paid2.payoutId, 900, 1, true, "Dueña L2"],
      [paid1.payoutId, 900, 1, false, "Dueña L2"],
    ]);

    // Only the latest of the professional.
    await expect(commissions.undoPayout(tenantId, paid1.payoutId!, owner)).rejects.toBeInstanceOf(ConflictException);

    await commissions.undoPayout(tenantId, paid2.payoutId!, owner);
    const undone = await row(second.id);
    expect(undone.commissionPaid).toBe(false);
    expect(undone.commissionDate).toBeNull();
    expect(Number(undone.commissionAmount)).toBe(Number(before.commissionAmount));
    expect((await row(first.id)).commissionPaid).toBe(true); // the earlier payout's item is untouched
    expect((await commissions.getCommissionSummary(tenantId, pro, later)).pendingCommission).toBe(900);
    expect((await commissions.getCommissionSummary(tenantId, pro, new Date())).paidCommission).toBe(900);

    const after = await commissions.listPayouts(tenantId, { professionalId: pro });
    expect(after.map((p) => [p.id, !!p.undoneAt, p.canUndo])).toEqual([
      [paid2.payoutId, true, false],
      [paid1.payoutId, false, true],
    ]);
    await expect(commissions.undoPayout(tenantId, paid2.payoutId!, owner)).rejects.toBeInstanceOf(ConflictException);

    const audit = await db.auditLog.findMany({ where: { tenantId, action: "commission.payout.undone" } });
    expect(audit).toEqual([
      expect.objectContaining({
        actorId: ownerUser,
        metadata: expect.objectContaining({ payoutId: paid2.payoutId, professionalId: pro }),
      }),
    ]);

    // Paid again: the same figure, a new payout.
    expect(await commissions.payCommission(tenantId, pro, { expectedAmount: 900 } as any, later, owner)).toMatchObject({
      count: 1,
      totalAmount: 900,
    });
  }, 60_000);

  it("Pagar hasta: the summary and the payout stop at that day", async () => {
    if (!reachable) return;
    const pro = await newPro(15);
    const dayAfter = new Date(Date.now() + 2 * 864e5).toISOString().slice(0, 10);
    const early: any = await book(pro);
    const late: any = await book(pro, { scheduledDate: dayAfter });
    for (const apt of [early, late]) {
      await agenda.complete(OWNER, apt.id);
      await charge(apt.id);
    }
    expect((await commissions.getCommissionSummary(tenantId, pro, later)).pendingCommission).toBe(1800);
    const upTo = await commissions.getCommissionSummary(tenantId, pro, later, tomorrow);
    expect(upTo).toMatchObject({ pendingCommission: 900, pendingUpTo: tomorrow });
    expect(upTo.appointments.map((a) => a.id)).toEqual([early.id]);

    const out = await commissions.payCommission(
      tenantId,
      pro,
      { endDate: new Date(tomorrow), expectedAmount: 900 } as any,
      later,
    );
    expect(out).toMatchObject({ count: 1, totalAmount: 900 });
    expect((await row(early.id)).commissionPaid).toBe(true);
    expect((await row(late.id)).commissionPaid).toBe(false);
    const payout = await db.commissionPayout.findUnique({ where: { id: out.payoutId } });
    expect(payout.upTo.toISOString().slice(0, 10)).toBe(tomorrow);
  }, 60_000);

  it("a product sold at the till earns its seller the product rate, in the summary, Pagar and the report", async () => {
    if (!reachable) return;
    const pro = await newPro(15);
    await db.professional.update({ where: { id: pro }, data: { productCommissionRate: 10 } });
    const productId = (
      await db.product.create({ data: { tenantId, name: "Champú", price: 20, quantity: 5, isActive: true } })
    ).id;
    await pos.processCheckout({
      tenantId,
      actor: OWNER,
      clientId,
      items: [{ productId, quantity: 1, professionalId: pro }],
      payments: [{ method: "card", amount: 2000 }],
    } as any);
    const line = await db.posSaleLine.findFirst({ where: { tenantId, productId } });
    expect(line).toMatchObject({ kind: "product", professionalId: pro, commissionBaseCents: 2000 });
    expect(Number(line.commissionAmount)).toBe(200);
    const summary = await commissions.getCommissionSummary(tenantId, pro, later);
    expect(summary.appointments).toEqual([
      expect.objectContaining({ source: "sale", kind: "product", commissionAmount: 200 }),
    ]);
    expect(await commissions.payCommission(tenantId, pro, { expectedAmount: 200 } as any, later)).toMatchObject({
      count: 1,
    });
    const report = await commissions.getPayrollReport(tenantId, reportFrom, later);
    expect(report.professionals.find((p) => p.id === pro)).toMatchObject({
      productSales: 2000,
      commission: 200,
      paid: 200,
    });
  }, 60_000);

  it("the salon's Comisión por defecto and Comisión sobre (net) apply, audit-logged", async () => {
    if (!reachable) return;
    const owner = { id: ownerUser, role: "owner" };
    // A new salon starts at 0 %.
    const fresh = await db.tenant.findUnique({ where: { id: tenantId } });
    expect(Number(fresh.commissionDefaultRate)).toBe(0);
    const zero = await newPro(null);
    const before: any = await book(zero);
    await agenda.complete(OWNER, before.id);
    await charge(before.id);
    expect((await commissions.getCommissionSummary(tenantId, zero, later)).pendingCommission).toBe(0);

    await commissions.updateSettings(tenantId, { defaultRate: 10, base: "net" } as any, owner);
    expect(await commissions.getSettings(tenantId)).toMatchObject({ defaultRate: 10, base: "net", pricesIncludeTax: true });
    // The rate is fixed when the visit is done: the earlier one stays at 0 %.
    expect((await commissions.getCommissionSummary(tenantId, zero, later)).pendingCommission).toBe(0);
    const pro = await newPro(null);
    const apt: any = await book(pro);
    await agenda.complete(OWNER, apt.id);
    await charge(apt.id);
    // 10 % of 49,59 (60,00 without the 21 %).
    expect((await commissions.getCommissionSummary(tenantId, pro, later)).pendingCommission).toBe(496);
    // The base follows the setting while it is not paid out: 10 % of 60,00.
    await commissions.updateSettings(tenantId, { base: "gross" } as any, owner);
    expect((await commissions.getCommissionSummary(tenantId, pro, later)).pendingCommission).toBe(600);
    const audit = await db.auditLog.findMany({ where: { tenantId, action: "commission.settings.updated" } });
    expect(audit).toHaveLength(2);
    await commissions.updateSettings(tenantId, { defaultRate: 0 } as any, owner);
  }, 60_000);
});
