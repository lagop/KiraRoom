import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { ConflictException } from "@nestjs/common";
import { PosService } from "./pos.service";
import { InvoiceService } from "../invoices/invoices.service";
import { InvoiceCalculator } from "../invoices/invoice-calculator.service";
import { WalletService } from "../payments/services/wallet.service";
import { PaymentsService } from "../payments/payments.service";
import { PromotionsService } from "../promotions/promotions.service";

/**
 * L2: promotion codes at the till against a real database.
 *
 *   - Five tills using the last use of a code at once: one sale, four 409s,
 *     usedCount 1, one use, and nothing of the refused sales left behind.
 *   - Two sales of the same client at once with a one-per-client code: one.
 *   - A full refund of the sale releases its use (usedCount back, the use
 *     marked released); a partial refund keeps it.
 *   - The sale's invoice stores the promotion's part of each line and its
 *     code; deleting a used promotion archives it and keeps its uses.
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
let pos: PosService;
let payments: PaymentsService;
const run = randomUUID().slice(0, 8).toUpperCase();
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
      name: "L2 promotions",
      slug: `l2-promos-${run}`,
      plan: "pro",
      subscriptionStatus: "active",
      timezone: "Europe/Madrid",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 864e5),
      fiscalSettings: { pricesIncludeTax: true, defaultTaxRate: 21, defaultSeries: "A" },
    },
  });
  tenantId = tenant.id;
  serviceId = (await db.service.create({ data: { tenantId, name: "Corte", category: "hair", duration: 30, price: 40 } })).id;
  clientId = (await db.client.create({ data: { tenantId, firstName: "Ana", lastName: "Prueba" } })).id;
  const fiscal = { dispatchInvoice: jest.fn(async () => undefined) };
  const invoices = new InvoiceService(db, new InvoiceCalculator(), fiscal as any);
  const wallet = new WalletService(db);
  pos = new PosService(db, wallet, undefined, invoices);
  payments = new PaymentsService(db, undefined, wallet);
}, 60_000);

afterAll(async () => {
  if (reachable && tenantId) {
    const where = { tenantId };
    await db.invoiceLine.deleteMany({ where: { invoice: where } }).catch(() => undefined);
    await db.invoice.deleteMany({ where }).catch(() => undefined);
    await db.refund.deleteMany({ where: { payment: where } }).catch(() => undefined);
    await db.payment.deleteMany({ where }).catch(() => undefined);
    await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

/** A promotion that started yesterday (the salon's day) and has no end. */
const promotion = (code: string, over: Record<string, unknown> = {}) =>
  db.promotion.create({
    data: {
      tenantId,
      name: `Promo ${code}`,
      code,
      type: "PERCENTAGE",
      value: 10,
      startDate: new Date(Date.now() - 2 * 864e5),
      isActive: true,
      ...over,
    },
  });

const sell = (code: string, over: Record<string, unknown> = {}) =>
  pos.processCheckout({
    tenantId,
    actor: OWNER,
    clientId,
    items: [{ serviceId, quantity: 1 }],
    promotionCode: code,
    // 40,00 - 10 % = 36,00, by card (no drawer needed).
    payments: [{ method: "card", amount: 3600 }],
    ...over,
  } as any);

describe("promotion codes at the till (L2, real database)", () => {
  it("five tills racing for the last use: one sale, the others a 409, nothing left behind", async () => {
    if (!reachable) return;
    const p = await promotion(`LAST-${run}`, { maxUses: 1 });
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => sell(p.code)));
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(4);
    // A 409 from the claim in the transaction (or, for a till that priced it after the
    // winner committed, the 400 of the quote): either way, no use left.
    for (const r of refused) expect(r.reason.message).toMatch(/máximo de usos/);
    expect(refused.some((r) => r.reason instanceof ConflictException)).toBe(true);

    const after = await db.promotion.findUnique({ where: { id: p.id } });
    expect(after.usedCount).toBe(1);
    const uses = await db.promotionUsage.findMany({ where: { promotionId: p.id } });
    expect(uses).toHaveLength(1);
    const saleId = (ok[0] as PromiseFulfilledResult<any>).value.saleId;
    expect(uses[0]).toMatchObject({ saleId, clientId, releasedAt: null });
    // The refused sales rolled back whole: one sale, one payment, one discount record.
    expect(await db.posSale.count({ where: { tenantId, promotionId: p.id } })).toBe(1);
    expect(await db.posDiscount.count({ where: { tenantId, promotionId: p.id } })).toBe(1);
    expect(await db.payment.count({ where: { tenantId, metadata: { path: ["promotionCode"], equals: p.code } } })).toBe(1);
  }, 60_000);

  it("two sales of the same client at once with a one-per-client code: one goes through", async () => {
    if (!reachable) return;
    const p = await promotion(`ONCE-${run}`, { maxUsesPerClient: 1 });
    const results = await Promise.allSettled([sell(p.code), sell(p.code)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
    expect(refused.reason.message).toMatch(/ya ha usado la promoción/);
    expect((await db.promotion.findUnique({ where: { id: p.id } })).usedCount).toBe(1);
    expect(await db.promotionUsage.count({ where: { promotionId: p.id, clientId } })).toBe(1);
    // Another client may still use it.
    const other = (await db.client.create({ data: { tenantId, firstName: "Eva", lastName: "Prueba" } })).id;
    await expect(sell(p.code, { clientId: other })).resolves.toMatchObject({ promotion: { code: p.code, discount: 400 } });
  }, 60_000);

  it("the sale's invoice keeps the promotion's part of each line and its code", async () => {
    if (!reachable) return;
    const p = await promotion(`INV-${run}`);
    const sale: any = await sell(p.code);
    const lines = await db.invoiceLine.findMany({ where: { invoiceId: sale.invoice.id } });
    expect(lines).toEqual([
      expect.objectContaining({ description: "Corte", totalCents: 3600, promotionDiscountCents: 400, promotionCode: p.code }),
    ]);
    const stored = await db.posSale.findUnique({ where: { id: sale.saleId } });
    expect(stored).toMatchObject({ discountCents: 400, promotionDiscountCents: 400, promotionCode: p.code, totalCents: 3600 });
    const receipt: any = await pos.getReceipt(tenantId, sale.saleId, OWNER);
    expect(receipt.promotion).toEqual({ code: p.code, discountCents: 400 });
  }, 60_000);

  it("a full refund releases the use; a partial one keeps it", async () => {
    if (!reachable) return;
    const p = await promotion(`BACK-${run}`, { maxUses: 2 });
    const partial: any = await sell(p.code);
    const full: any = await sell(p.code);
    expect((await db.promotion.findUnique({ where: { id: p.id } })).usedCount).toBe(2);

    await payments.refundPayment(tenantId, partial.payments[0].id, { amount: 1000, reason: "Parte" }, OWNER.id);
    expect((await db.promotion.findUnique({ where: { id: p.id } })).usedCount).toBe(2);
    expect((await db.promotionUsage.findFirst({ where: { saleId: partial.saleId } })).releasedAt).toBeNull();

    await payments.refundPayment(tenantId, full.payments[0].id, { reason: "Todo" }, OWNER.id);
    expect((await db.promotion.findUnique({ where: { id: p.id } })).usedCount).toBe(1);
    expect((await db.promotionUsage.findFirst({ where: { saleId: full.saleId } })).releasedAt).toBeInstanceOf(Date);

    // The use given back is there for the next client.
    await expect(sell(p.code)).resolves.toMatchObject({ promotion: { code: p.code } });
    // The rest of the partially refunded sale given back: now its use goes too.
    await payments.refundPayment(tenantId, partial.payments[0].id, { reason: "El resto" }, OWNER.id);
    expect((await db.promotion.findUnique({ where: { id: p.id } })).usedCount).toBe(1);
    expect((await db.promotionUsage.findFirst({ where: { saleId: partial.saleId } })).releasedAt).toBeInstanceOf(Date);
  }, 60_000);

  it("deleting a used promotion archives it: its uses stay, its code no longer works", async () => {
    if (!reachable) return;
    const p = await promotion(`ARCH-${run}`);
    await sell(p.code);
    const promotions = new PromotionsService(db);
    expect(await promotions.delete(p.id, tenantId)).toEqual({ id: p.id, deleted: false, archived: true });
    expect(await db.promotionUsage.count({ where: { promotionId: p.id } })).toBe(1);
    expect((await promotions.getAll(tenantId)).some((x: any) => x.id === p.id)).toBe(false);
    await expect(sell(p.code)).rejects.toThrow("La promoción ya no está activa.");

    const unused = await promotion(`GONE-${run}`);
    expect(await promotions.delete(unused.id, tenantId)).toEqual({ id: unused.id, deleted: true, archived: false });
    expect(await db.promotion.findUnique({ where: { id: unused.id } })).toBeNull();
  }, 60_000);
});
