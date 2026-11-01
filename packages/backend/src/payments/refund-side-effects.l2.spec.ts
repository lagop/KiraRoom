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

  it("partial refunds take back their share of the points with a ledger entry; the full refund the rest; never below zero", async () => {
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

    // Never below zero: a client who already spent her points.
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
    expect(await points()).toBe(0);
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
});
