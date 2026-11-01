import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { ConflictException } from "@nestjs/common";
import { PosService } from "../pos/pos.service";
import { InvoiceService } from "../invoices/invoices.service";
import { InvoiceCalculator } from "../invoices/invoice-calculator.service";
import { WalletService } from "./services/wallet.service";
import { PaymentsService } from "./payments.service";
import { LoyaltyService } from "../loyalty/loyalty.service";
import { CommissionsService } from "../commissions/commissions.service";
import { AuditLogService } from "../saas/audit-log.service";
import { recordRefundClawbacks } from "../commissions/commission-clawback";

/**
 * L2: what a refund changes besides the money, and the loyalty reward on
 * the invoice, against a real database (owner decisions 2026-11-02).
 *
 *   - A product line given back returns to stock with a "return" movement;
 *     an amount alone restocks nothing; the whole sale returns the rest.
 *   - A walk-in service refunded no longer earns its commission (in
 *     proportion, then none).
 *   - A partial refund takes back its share of the points, with a ledger
 *     entry; the full refund the rest; never below zero.
 *   - A cash refund needs the drawer open (409 CASH_SESSION_CLOSED); card
 *     does not.
 *   - The loyalty reward is a discount on the sale's simplified invoice
 *     (shared by tax base over mixed rates) and on the visit's invoice
 *     (issued later, or by a rectificativa when it was issued already).
 *   - A refund after the commission was paid takes it back with an
 *     adjustment ("Ajuste por devolución"), once per refund, netted into the
 *     next payout and shown in its own period (commission-clawback.ts).
 *
 * Skipped when no database is reachable, so `npm test` stays green on a
 * workstation without Postgres. CI provides one.
 */
const prisma = new PrismaClient();
const db: any = prisma;
let reachable = false;
let tenantId: string;
let pos: PosService;
let payments: PaymentsService;
let invoices: InvoiceService;
let commissions: CommissionsService;
let sessionId: string;
let serviceId: string;
let professionalId: string;
let clientId: string;
let rewardId: string;
let memberId: string;
const run = randomUUID().slice(0, 8);
const OWNER = { id: "l2-owner", role: "owner" };

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
      name: "L2 refunds",
      slug: `l2-refunds-${run}`,
      plan: "pro",
      subscriptionStatus: "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 864e5),
      // Prices with the tax included (every new salon): money = catalogue.
      fiscalSettings: { pricesIncludeTax: true, defaultTaxRate: 21, defaultSeries: "A" },
    },
  });
  tenantId = tenant.id;
  sessionId = (await db.cashSession.create({ data: { tenantId, openedById: OWNER.id, openingFloatCents: 0 } })).id;
  serviceId = (await db.service.create({ data: { tenantId, name: "Corte", category: "hair", duration: 30, price: 30 } })).id;
  professionalId = (
    await db.professional.create({
      data: { tenantId, firstName: "Pro", lastName: "Fesional", email: `pro-${run}@example.test`, hireDate: new Date(), commissionRate: 10 },
    })
  ).id;
  clientId = (await db.client.create({ data: { tenantId, firstName: "Ana", lastName: "Prueba" } })).id;

  const program = await db.loyaltyProgram.create({
    data: { tenantId, isActive: true, pointsPerEuro: 1, minPointsRedemption: 0 },
  });
  rewardId = (
    await db.loyaltyReward.create({
      data: { programId: program.id, name: "5 € de descuento", type: "discount", discountAmount: 500, pointsCost: 10 },
    })
  ).id;
  memberId = (
    await db.loyaltyMember.create({ data: { clientId, programId: program.id, currentPoints: 1000, status: "active" } })
  ).id;

  const fiscal = { dispatchInvoice: jest.fn(async () => undefined) };
  invoices = new InvoiceService(db, new InvoiceCalculator(), fiscal as any);
  const flags: any = { isFeatureUnlocked: jest.fn(async () => true) };
  const loyalty = new LoyaltyService(db, flags);
  const wallet = new WalletService(db);
  pos = new PosService(db, wallet, loyalty, invoices);
  payments = new PaymentsService(db, loyalty, wallet);
  commissions = new CommissionsService(db);
}, 60_000);

afterAll(async () => {
  if (reachable && tenantId) {
    const where = { tenantId };
    await db.invoiceLine.deleteMany({ where: { invoice: where } }).catch(() => undefined);
    await db.invoice.deleteMany({ where }).catch(() => undefined);
    await db.payment.deleteMany({ where }).catch(() => undefined);
    await db.appointment.deleteMany({ where }).catch(() => undefined);
    await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

const product = (name: string, price: number, quantity: number, taxRate?: number) =>
  db.product.create({
    data: { tenantId, name: `${name} ${randomUUID().slice(0, 4)}`, price, quantity, trackInventory: true, isActive: true, ...(taxRate !== undefined ? { taxRate } : {}) },
  });

const salePayments = (saleId: string) =>
  db.payment.findMany({ where: { tenantId, metadata: { path: ["posSaleId"], equals: saleId } }, orderBy: { amount: "asc" } });

const lineOf = (saleId: string, kind: string) => db.posSaleLine.findFirst({ where: { saleId, kind } });

const points = async () => (await db.loyaltyMember.findUnique({ where: { id: memberId } })).currentPoints as number;

describe("refunds and their side effects (L2, real database)", () => {
  it("a product line given back returns to stock; an amount alone does not; the whole sale returns the rest; commissions follow", async () => {
    if (!reachable) return;
    const champu = await product("Champú", 12, 10);
    const sale: any = await pos.processCheckout({
      tenantId,
      actor: OWNER,
      items: [
        { productId: champu.id, quantity: 3 },
        { serviceId, quantity: 1, professionalId },
      ],
      payments: [{ method: "cash", amount: 6600 }],
    } as any);
    expect((await db.product.findUnique({ where: { id: champu.id } })).quantity).toBe(7);
    const rows = await salePayments(sale.saleId);
    const productPayment = rows.find((p: any) => p.type === "product");
    const servicePayment = rows.find((p: any) => p.type === "service");
    expect(productPayment.amount).toBe(3600);
    expect(servicePayment.amount).toBe(3000);
    const champuLine = await lineOf(sale.saleId, "product");

    // The panel's dialog reads the lines.
    const listed = await payments.refundLines(tenantId, productPayment.id);
    expect(listed.saleId).toBe(sale.saleId);
    expect(listed.lines.find((l: any) => l.id === champuLine.id)).toMatchObject({ refundableQuantity: 3, refundableCents: 3600 });

    // One unit back: 12,00 by default, restocked with its movement.
    const one: any = await payments.refundPayment(
      tenantId,
      productPayment.id,
      { reason: "Producto defectuoso", lines: [{ lineId: champuLine.id, quantity: 1 }] },
      OWNER.id,
    );
    expect(one.refund.amount).toBe(1200);
    expect(one.restocked).toEqual([{ productId: champu.id, description: champuLine.description, quantity: 1 }]);
    expect(one.refund.cashSessionId).toBe(sessionId);
    expect((await db.product.findUnique({ where: { id: champu.id } })).quantity).toBe(8);
    const movement = await db.inventoryTransaction.findFirst({ where: { productId: champu.id, type: "return" } });
    expect(movement).toMatchObject({ quantity: 1, previousQty: 7, newQty: 8, reason: "Devolución en caja" });
    expect(movement.notes).toContain("Producto defectuoso");
    expect(await lineOf(sale.saleId, "product")).toMatchObject({ refundedQuantity: 1, refundedCents: 1200 });
    expect((await db.refund.findUnique({ where: { id: one.refund.id } })).saleLines).toEqual([
      { lineId: champuLine.id, quantity: 1, cents: 1200 },
    ]);
    // The invoice of the sale is named for its rectificativa.
    expect(one.rectificationNeeded).toBe(true);
    expect(one.invoice.number).toMatch(/^T/);

    // Six euros back with no lines: nothing restocked.
    const amountOnly: any = await payments.refundPayment(tenantId, productPayment.id, { amount: 600, reason: "Rebaja" }, OWNER.id);
    expect(amountOnly.restocked).toEqual([]);
    expect((await db.product.findUnique({ where: { id: champu.id } })).quantity).toBe(8);
    expect(await lineOf(sale.saleId, "product")).toMatchObject({ refundedQuantity: 1, refundedCents: 1800 });

    // More units than are left: refused.
    await expect(
      payments.refundPayment(tenantId, productPayment.id, { reason: "x", lines: [{ lineId: champuLine.id, quantity: 3 }] }),
    ).rejects.toThrow(/solo quedan 2/);

    // The walk-in service: 10 % of 30,00 = 3,00 (in cents, like every commission); a third given back, 2,00 left.
    const before = await commissions.getCommissionSummary(tenantId, professionalId);
    expect(before.appointments.find((a) => a.source === "sale")?.commissionAmount).toBe(300);
    await payments.refundPayment(tenantId, servicePayment.id, { amount: 1000, reason: "Queja" }, OWNER.id);
    const third = await commissions.getCommissionSummary(tenantId, professionalId);
    expect(third.appointments.find((a) => a.source === "sale")).toMatchObject({ commissionAmount: 200, amount: 2000 });
    // All of it back: no commission.
    await payments.refundPayment(tenantId, servicePayment.id, { reason: "Queja" }, OWNER.id);
    const none = await commissions.getCommissionSummary(tenantId, professionalId);
    expect(none.appointments.filter((a) => a.source === "sale")).toEqual([]);
    expect(none.pendingCommission).toBe(0);
    const payroll = await commissions.getPayrollReport(tenantId, new Date(Date.now() - 864e5), new Date(Date.now() + 864e5));
    expect(payroll.professionals.find((p) => p.id === professionalId)?.commission).toBe(0);

    // The rest of the product payment: the whole sale is given back, the two units left return.
    const last: any = await payments.refundPayment(tenantId, productPayment.id, { reason: "Devuelve todo" }, OWNER.id);
    expect(last.refund.amount).toBe(1800);
    expect(last.restocked).toEqual([{ productId: champu.id, description: champuLine.description, quantity: 2 }]);
    expect((await db.product.findUnique({ where: { id: champu.id } })).quantity).toBe(10);
    expect(await lineOf(sale.saleId, "product")).toMatchObject({ refundedQuantity: 3, refundedCents: 3600 });
    expect(await lineOf(sale.saleId, "service")).toMatchObject({ refundedQuantity: 1, refundedCents: 3000 });

    // The drawer's report counts every cash refund of the session.
    const linked = await db.refund.findMany({ where: { cashSessionId: sessionId, payment: { metadata: { path: ["posSaleId"], equals: sale.saleId } } } });
    expect(linked.reduce((s: number, r: any) => s + r.amount, 0)).toBe(6600);
  }, 60_000);

  it("partial refunds take back their share of the points with a ledger entry; the full refund the rest; below zero when they were spent already", async () => {
    if (!reachable) return;
    const start = await points();
    const sale: any = await pos.processCheckout({
      tenantId,
      actor: OWNER,
      clientId,
      items: [{ serviceId, quantity: 1, professionalId }],
      payments: [{ method: "card", amount: 3000 }],
    } as any);
    expect(sale.loyalty.pointsEarned).toBe(30);
    expect(await points()).toBe(start + 30);
    const [payment] = await salePayments(sale.saleId);

    const part: any = await payments.refundPayment(tenantId, payment.id, { amount: 1000, reason: "Parcial" }, OWNER.id);
    expect(await points()).toBe(start + 20);
    const entry = await db.loyaltyTransaction.findFirst({ where: { memberId, type: "reversal", source: "refund", sourceId: part.refund.id } });
    expect(entry).toMatchObject({ points: -10 });
    expect(entry.metadata).toMatchObject({ posSaleId: sale.saleId, paymentId: payment.id, refundCents: 1000 });

    // The client's spend follows: 30,00 paid, 10,00 given back.
    expect(Number((await db.client.findUnique({ where: { id: clientId } })).totalSpent)).toBe(20);

    await payments.refundPayment(tenantId, payment.id, { reason: "El resto" }, OWNER.id);
    expect(await points()).toBe(start);

    // A client who already spent her points goes below zero (audit L4):
    // her next visits pay it off.
    const sale2: any = await pos.processCheckout({
      tenantId,
      actor: OWNER,
      clientId,
      items: [{ serviceId, quantity: 1, professionalId }],
      payments: [{ method: "card", amount: 3000 }],
    } as any);
    const [payment2] = await salePayments(sale2.saleId);
    await db.loyaltyMember.update({ where: { id: memberId }, data: { currentPoints: 5 } });
    await payments.refundPayment(tenantId, payment2.id, { amount: 1500, reason: "Parcial" }, OWNER.id);
    expect(await points()).toBe(-10);
    await db.loyaltyMember.update({ where: { id: memberId }, data: { currentPoints: start } });
  }, 60_000);

  it("the loyalty reward is a discount on the sale's simplified invoice, shared by tax base over mixed rates", async () => {
    if (!reachable) return;
    const crema = await product("Crema", 10, 5, 0.1);
    const sale: any = await pos.processCheckout({
      tenantId,
      actor: OWNER,
      clientId,
      loyaltyRewardId: rewardId,
      items: [
        { serviceId, quantity: 1, professionalId },
        { productId: crema.id, quantity: 1 },
      ],
      payments: [{ method: "card", amount: 3500 }],
    } as any);
    expect(sale.total).toBe(3500);
    const invoice = await db.invoice.findUnique({ where: { id: sale.invoice.id }, include: { lines: { orderBy: { totalCents: "desc" } } } });
    // The invoice comes to what was charged.
    expect(invoice.totalCents).toBe(3500);
    // Bases 24,79 (21 %) and 9,09 (10 %): 5,00 shared 3,66 / 1,34 (the rounding cent on the largest).
    expect(invoice.lines.map((l: any) => l.loyaltyDiscountCents)).toEqual([366, 134]);
    expect(invoice.lines.map((l: any) => l.totalCents)).toEqual([2634, 866]);
    // Each rate's base and tax add up to the invoice.
    const breakdown = invoice.taxBreakdown as Array<{ rate: number; baseCents: number; taxCents: number }>;
    expect(breakdown.reduce((s, t) => s + t.baseCents + t.taxCents, 0)).toBe(3500);
    expect(breakdown.find((t) => t.rate === 21)).toEqual({ rate: 21, baseCents: 2177, taxCents: 457 });
    expect(breakdown.find((t) => t.rate === 10)).toEqual({ rate: 10, baseCents: 787, taxCents: 79 });
    expect(invoice.subtotalCents + breakdown.reduce((s, t) => s + t.taxCents, 0)).toBe(invoice.totalCents);
    // The sale's lines say the same (receipt, refunds by line).
    const lines = await db.posSaleLine.findMany({ where: { saleId: sale.saleId }, orderBy: { lineIndex: "asc" } });
    expect(lines.map((l: any) => [l.totalCents, l.loyaltyDiscountCents])).toEqual([
      [2634, 366],
      [866, 134],
    ]);
    // The rectificativa of the whole invoice nets it to zero.
    const rect = await invoices.emitRectification(tenantId, invoice.id, undefined, "Devolución de la venta");
    const r = await db.invoice.findUnique({ where: { id: rect.id } });
    expect(r.totalCents).toBe(-3500);
  }, 60_000);

  it("the loyalty reward on a visit: on its invoice issued later, and by a rectificativa when it was issued already", async () => {
    if (!reachable) return;
    const visit = (total: number) =>
      db.appointment.create({
        data: {
          tenantId,
          clientId,
          serviceId,
          professionalId,
          scheduledDate: new Date(),
          scheduledTime: "10:00",
          duration: 30,
          endTime: "10:30",
          price: total / 100,
          totalAmount: total,
          status: "completed",
        },
      });
    // Not invoiced yet: its invoice, issued after the sale, takes the reward off.
    const a = await visit(3000);
    await pos.processCheckout({
      tenantId,
      actor: OWNER,
      clientId,
      appointmentIds: [a.id],
      loyaltyRewardId: rewardId,
      payments: [{ method: "card", amount: 2500 }],
    } as any);
    const stored = await db.appointment.findUnique({ where: { id: a.id } });
    expect(stored).toMatchObject({ paymentStatus: "paid" });
    expect(Number(stored.price)).toBe(30);
    expect((stored.discount as any).loyalty).toMatchObject({ moneyCents: 500, catalogueCents: 500 });
    const issued = await invoices.fromAppointment(a.id, { tenantId, requested: true });
    const inv = await db.invoice.findUnique({ where: { id: issued!.id }, include: { lines: true } });
    expect(inv.totalCents).toBe(2500);
    expect(inv.lines[0]).toMatchObject({ loyaltyDiscountCents: 500 });

    // Invoiced before it was charged: a rectificativa for the reward, with the sale.
    const b = await visit(3000);
    const first = await invoices.fromAppointment(b.id, { tenantId, requested: true });
    const out: any = await pos.processCheckout({
      tenantId,
      actor: OWNER,
      clientId,
      appointmentIds: [b.id],
      loyaltyRewardId: rewardId,
      payments: [{ method: "card", amount: 2500 }],
    } as any);
    expect(out.loyaltyRectifications).toHaveLength(1);
    const rect = await db.invoice.findUnique({ where: { id: out.loyaltyRectifications[0].invoiceId } });
    expect(rect.series).toBe("R");
    expect(rect.totalCents).toBe(-500);
    expect(rect.notes).toContain("Descuento fidelidad");
    const original = await db.invoice.findUnique({ where: { id: first!.id } });
    expect(original.totalCents + rect.totalCents).toBe(2500);
  }, 60_000);

  it("a cash refund needs the drawer open (409 CASH_SESSION_CLOSED); a card one does not", async () => {
    if (!reachable) return;
    const cashSale: any = await pos.processCheckout({
      tenantId,
      actor: OWNER,
      items: [{ serviceId, quantity: 1, professionalId }],
      payments: [{ method: "cash", amount: 3000 }],
    } as any);
    const cardSale: any = await pos.processCheckout({
      tenantId,
      actor: OWNER,
      items: [{ serviceId, quantity: 1, professionalId }],
      payments: [{ method: "card", amount: 3000 }],
    } as any);
    await db.cashSession.update({ where: { id: sessionId }, data: {
        status: "closed",
        closedAt: new Date(),
        closedById: OWNER.id,
        countedCashCents: 0,
        expectedCashCents: 0,
        discrepancyCents: 0,
      },
    });
    try {
      const [cash] = await salePayments(cashSale.saleId);
      const err: any = await payments.refundPayment(tenantId, cash.id, { amount: 500, reason: "x" }).catch((e) => e);
      expect(err).toBeInstanceOf(ConflictException);
      expect(err.getResponse()).toMatchObject({ code: "CASH_SESSION_CLOSED" });
      expect(await db.refund.count({ where: { paymentId: cash.id } })).toBe(0);
      expect((await db.payment.findUnique({ where: { id: cash.id } })).status).toBe("paid");

      const [card] = await salePayments(cardSale.saleId);
      const ok: any = await payments.refundPayment(tenantId, card.id, { amount: 500, reason: "x" });
      expect(ok.refund).toMatchObject({ amount: 500, cashSessionId: null });
    } finally {
      await db.cashSession.update({ where: { id: sessionId }, data: {
          status: "open",
          closedAt: null,
          closedById: null,
          countedCashCents: null,
          expectedCashCents: null,
          discrepancyCents: null,
        },
      });
    }
  }, 60_000);

  it("a reward the visit's issued invoice cannot take: the sale goes through, flagged on the payment, the answer and the audit log", async () => {
    if (!reachable) return;
    const user = await db.user.create({
      data: { tenantId, email: `l2-refunds-${run}@example.test`, firstName: "Ana", lastName: "Dueña", role: "owner", passwordHash: "not-a-real-hash" },
    });
    try {
      const audited = new PosService(db, new WalletService(db), new LoyaltyService(db, { isFeatureUnlocked: jest.fn(async () => true) } as any), invoices, undefined, new AuditLogService(db));
      const apt = await db.appointment.create({
        data: {
          tenantId,
          clientId,
          serviceId,
          professionalId,
          scheduledDate: new Date(),
          scheduledTime: "11:00",
          duration: 30,
          endTime: "11:30",
          price: 30,
          totalAmount: 3000,
          status: "completed",
        },
      });
      // Its invoice, issued and then credited whole: nothing left to take the reward.
      const first = await invoices.fromAppointment(apt.id, { tenantId, requested: true });
      await prisma.$transaction((tx) => invoices.rectifyByAmountIn(tx, tenantId, first!.id, 3000, "Abono entero"));

      const out: any = await audited.processCheckout({
        tenantId,
        actor: { id: user.id, role: "owner" },
        clientId,
        appointmentIds: [apt.id],
        loyaltyRewardId: rewardId,
        payments: [{ method: "card", amount: 2500 }],
      } as any);
      expect(out.loyaltyRectifications).toBeUndefined();
      expect(out.loyaltyNotOnInvoice).toEqual([
        { appointmentId: apt.id, invoiceId: first!.id, invoice: expect.stringMatching(/^A/), amountCents: 500 },
      ]);
      const [payment] = await salePayments(out.saleId);
      expect(payment.metadata.loyaltyNotOnInvoice).toMatchObject({ invoiceId: first!.id, amountCents: 500 });
      const stored = await db.appointment.findUnique({ where: { id: apt.id } });
      expect((stored.discount as any).loyalty).toMatchObject({ notOnInvoice: out.loyaltyNotOnInvoice[0].invoice, notOnInvoiceId: first!.id });
      const logs = await db.auditLog.findMany({ where: { tenantId, action: "pos.loyalty_not_on_invoice" } });
      expect(logs).toHaveLength(1);
      expect(logs[0]).toMatchObject({ actorId: user.id, metadata: expect.objectContaining({ saleId: out.saleId, appointmentId: apt.id, moneyCents: 500 }) });
    } finally {
      await db.auditLog.deleteMany({ where: { actorId: user.id } });
      await db.user.delete({ where: { id: user.id } });
    }
  }, 60_000);

  it("prices as the base: the visit's invoice, and the rectificativa of one issued before, come to the money to the cent", async () => {
    if (!reachable) return;
    const included = (await db.tenant.findUnique({ where: { id: tenantId } })).fiscalSettings;
    await db.tenant.update({ where: { id: tenantId }, data: { fiscalSettings: { pricesIncludeTax: false, defaultTaxRate: 21, defaultSeries: "A" } } });
    try {
      // 20,02 + 21 % = 24,22 of money; 5,00 of reward -> 19,22 paid. No base gives exactly 19,22
      // with its tax (15,88 -> 19,21, 15,89 -> 19,23): the invoice's tax takes the cent.
      const visit = () =>
        db.appointment.create({
          data: {
            tenantId,
            clientId,
            serviceId,
            professionalId,
            scheduledDate: new Date(),
            scheduledTime: "12:00",
            duration: 30,
            endTime: "12:30",
            price: 20.02,
            totalAmount: 2002,
            status: "completed",
          },
        });
      const sell = (appointmentId: string) =>
        pos.processCheckout({
          tenantId,
          actor: OWNER,
          clientId,
          appointmentIds: [appointmentId],
          loyaltyRewardId: rewardId,
          payments: [{ method: "card", amount: 1922 }],
        } as any);

      const later = await visit();
      await sell(later.id);
      const stored = await db.appointment.findUnique({ where: { id: later.id } });
      expect((stored.discount as any).loyalty).toMatchObject({ moneyCents: 500 });
      const issued = await invoices.fromAppointment(later.id, { tenantId, requested: true });
      const inv = await db.invoice.findUnique({ where: { id: issued!.id } });
      expect(inv.totalCents).toBe(1922);

      const before = await visit();
      const first = await invoices.fromAppointment(before.id, { tenantId, requested: true });
      const out: any = await sell(before.id);
      const rect = await db.invoice.findUnique({ where: { id: out.loyaltyRectifications[0].invoiceId } });
      const original = await db.invoice.findUnique({ where: { id: first!.id } });
      expect(original.totalCents).toBe(2422);
      expect(rect.totalCents).toBe(-500);
    } finally {
      await db.tenant.update({ where: { id: tenantId }, data: { fiscalSettings: included } });
    }
  }, 60_000);
  it("a refund after the commission was paid: an adjustment for the professional, once, in the next payout and its own period", async () => {
    if (!reachable) return;
    const pro = (
      await db.professional.create({
        data: { tenantId, firstName: "Clawback", lastName: "Pro", email: `claw-${run}@example.test`, hireDate: new Date(), commissionRate: 10 },
      })
    ).id;
    // A walk-in service (30,00, commission 3,00) and a visit (30,00, commission 4,00), both charged by card.
    const sale: any = await pos.processCheckout({
      tenantId,
      actor: OWNER,
      items: [{ serviceId, quantity: 1, professionalId: pro }],
      payments: [{ method: "card", amount: 3000 }],
    } as any);
    const linePayment = (await salePayments(sale.saleId))[0];
    const line = await lineOf(sale.saleId, "service");
    const apt = await db.appointment.create({
      data: {
        tenantId, clientId, serviceId, professionalId: pro, scheduledDate: new Date(), scheduledTime: "11:00",
        duration: 30, endTime: "11:30", price: 30, totalAmount: 3000, status: "completed", commissionAmount: 400,
      },
    });
    await pos.processCheckout({ tenantId, actor: OWNER, clientId, appointmentIds: [apt.id], payments: [{ method: "card", amount: 3000 }] } as any);
    const aptPayment = await db.payment.findFirst({ where: { tenantId, appointmentId: apt.id, status: "paid" } });
    expect(aptPayment).toBeTruthy();

    // Before the payout a refund only lowers what will be paid: no adjustment.
    await payments.refundPayment(tenantId, linePayment.id, { amount: 300, reason: "Retoque" }, OWNER.id);
    expect(await db.commissionAdjustment.count({ where: { tenantId, professionalId: pro } })).toBe(0);
    const paid = await commissions.payCommission(tenantId, pro, {} as any);
    expect(paid.totalAmount).toBe(270 + 400);

    // After it: the refund takes its share back, linked to it.
    const r1: any = await payments.refundPayment(tenantId, linePayment.id, { amount: 900, reason: "Queja" }, OWNER.id);
    const r2: any = await payments.refundPayment(tenantId, aptPayment.id, { amount: 1500, reason: "Queja" }, OWNER.id);
    const rows = await db.commissionAdjustment.findMany({ where: { tenantId, professionalId: pro }, orderBy: { amount: "asc" } });
    expect(rows.map((r: any) => [r.refundId, r.sourceKey, Number(r.amount), r.settled])).toEqual([
      [r2.refund.id, `appointment:${apt.id}`, -200, false],
      [r1.refund.id, `sale_line:${line.id}`, -90, false],
    ]);
    // Recording the same refund again changes nothing.
    expect(
      await recordRefundClawbacks(db, { tenantId, refundId: r1.refund.id, amount: 900, lines: [{ lineId: line.id, cents: 900 }] }),
    ).toBe(0);
    expect(await db.commissionAdjustment.count({ where: { tenantId, professionalId: pro } })).toBe(2);

    // The summary: pending, "Ajuste por devolución".
    const summary = await commissions.getCommissionSummary(tenantId, pro);
    expect(summary.appointments.filter((a) => a.source === "refund_adjustment").map((a) => a.commissionAmount).sort()).toEqual([-200, -90]);
    expect(summary.appointments.every((a) => a.source !== "refund_adjustment" || a.serviceName.startsWith("Ajuste por devolución"))).toBe(true);
    expect(summary.pendingCommission).toBe(-290);

    // Recorded next month: this period keeps what was paid, the next one carries the adjustment.
    const nextMonth = new Date(Date.now() + 40 * 864e5);
    await db.commissionAdjustment.updateMany({ where: { tenantId, professionalId: pro }, data: { createdAt: nextMonth } });
    const now = await commissions.getPayrollReport(tenantId, new Date(Date.now() - 864e5), new Date(Date.now() + 864e5));
    expect(now.professionals.find((p) => p.id === pro)).toMatchObject({ commission: 670, refundAdjustments: 0 });
    const later = await commissions.getPayrollReport(tenantId, new Date(nextMonth.getTime() - 864e5), new Date(nextMonth.getTime() + 864e5));
    expect(later.professionals.find((p) => p.id === pro)).toMatchObject({ commission: -290, refundAdjustments: -290 });

    // The next payout, made next month (Pagar pays what is pending up to that day), nets and settles them.
    const payDay = new Date(nextMonth.getTime() + 864e5);
    const next = await commissions.payCommission(tenantId, pro, {} as any, payDay);
    expect(next.totalAmount).toBe(-290);
    expect(await db.commissionAdjustment.count({ where: { tenantId, professionalId: pro, settled: false } })).toBe(0);
    expect((await commissions.getCommissionSummary(tenantId, pro, payDay)).pendingCommission).toBe(0);
  }, 60_000);
});
