import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { PosService } from "./pos.service";
import { InvoiceService } from "../invoices/invoices.service";
import { InvoiceCalculator } from "../invoices/invoice-calculator.service";
import { WalletService } from "../payments/services/wallet.service";

/**
 * L2: the till against a real database.
 *
 *   - Two tills selling the last unit of a product at once: one sale, the
 *     other a 400 "Sin stock suficiente", the stock never below zero and
 *     everything of the refused sale rolled back (payment, invoice, sale).
 *   - The same sale sent twice at once (a double tap, a retry): one sale,
 *     one payment, one invoice; both answers are that sale.
 *
 * Skipped when no database is reachable, so `npm test` stays green on a
 * workstation without Postgres. CI provides one.
 */
const prisma = new PrismaClient();
const db: any = prisma;
let reachable = false;
let tenantId: string;
let pos: PosService;
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
      name: "L2 till",
      slug: `l2-till-${run}`,
      plan: "pro",
      subscriptionStatus: "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 864e5),
      fiscalSettings: { pricesIncludeTax: false, defaultTaxRate: 21, defaultSeries: "A" },
    },
  });
  tenantId = tenant.id;
  const fiscal = { dispatchInvoice: jest.fn(async () => undefined) };
  const invoices = new InvoiceService(db, new InvoiceCalculator(), fiscal as any);
  pos = new PosService(db, new WalletService(db), undefined, invoices);
}, 60_000);

afterAll(async () => {
  if (reachable && tenantId) {
    await db.invoiceLine.deleteMany({ where: { invoice: { tenantId } } }).catch(() => undefined);
    await db.invoice.deleteMany({ where: { tenantId } }).catch(() => undefined);
    await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

const product = (quantity: number) =>
  db.product.create({
    data: { tenantId, name: `Champú ${randomUUID().slice(0, 4)}`, price: 10, quantity, trackInventory: true, isActive: true },
  });

const sell = (productId: string, saleId?: string) =>
  pos.processCheckout({
    tenantId,
    actor: OWNER,
    ...(saleId ? { saleId } : {}),
    items: [{ productId, quantity: 1 }],
    // 10,00 + 21 % on top: 12,10 charged, the invoice total.
    payments: [{ method: "cash", amount: 1210 }],
  } as any);

describe("the till (L2, real database)", () => {
  it("two tills selling the last unit at once: one sale, the other refused, nothing left behind", async () => {
    if (!reachable) return;
    const p = await product(1);
    const results = await Promise.allSettled([sell(p.id), sell(p.id)]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const refused = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(ok).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0].reason.message).toMatch(/^Sin stock suficiente de Champú/);

    expect((await db.product.findUnique({ where: { id: p.id } })).quantity).toBe(0);
    const moves = await db.inventoryTransaction.findMany({ where: { productId: p.id } });
    expect(moves).toHaveLength(1);
    expect(moves[0]).toMatchObject({ type: "sale", quantity: -1, previousQty: 1, newQty: 0 });

    const saleId = (ok[0] as PromiseFulfilledResult<any>).value.saleId;
    const sales = await db.posSale.findMany({ where: { tenantId, lines: { some: { productId: p.id } } } });
    expect(sales.map((s: any) => s.id)).toEqual([saleId]);
    const payments = await db.payment.findMany({ where: { tenantId, metadata: { path: ["posSaleId"], equals: saleId } } });
    expect(payments).toHaveLength(1);
    expect(payments[0]).toMatchObject({ amount: 1210, type: "product", recordedById: "l2-owner" });
    const invoices = await db.invoice.findMany({ where: { tenantId, sourceType: "pos_sale", sourceId: saleId } });
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ series: "T", totalCents: 1210 });
  }, 60_000);

  it("the same sale twice at once: recorded once, both answers are that sale", async () => {
    if (!reachable) return;
    const p = await product(5);
    const requestId = randomUUID();
    const [a, b] = await Promise.all([sell(p.id, requestId), sell(p.id, requestId)]);
    expect(a.saleId).toBe(b.saleId);
    expect((await db.product.findUnique({ where: { id: p.id } })).quantity).toBe(4);
    expect(await db.posSale.count({ where: { tenantId, requestId } })).toBe(1);
    expect(await db.payment.count({ where: { tenantId, metadata: { path: ["posSaleId"], equals: a.saleId } } })).toBe(1);
    expect(await db.invoice.count({ where: { tenantId, sourceType: "pos_sale", sourceId: a.saleId } })).toBe(1);
  }, 60_000);
});
