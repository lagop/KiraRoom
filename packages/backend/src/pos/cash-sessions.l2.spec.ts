import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { PosService } from "./pos.service";
import { CashSessionsService } from "./cash-sessions.service";
import { InvoiceService } from "../invoices/invoices.service";
import { InvoiceCalculator } from "../invoices/invoice-calculator.service";
import { WalletService } from "../payments/services/wallet.service";
import { PaymentsService } from "../payments/payments.service";
import { AuditLogService } from "../saas/audit-log.service";

/**
 * L2: the cash drawer (arqueo) against a real database.
 *
 *   - One open session per salon, by the partial unique index: two "Abrir
 *     caja" at once give one session.
 *   - A day at the till: float, a cash sale with change, a card sale, a
 *     mixed one, a cash refund, money taken out; the close stores what the
 *     drawer should hold and the difference with the count.
 *   - Closing while sales are being charged: every cash sale either is in
 *     the count or is refused because the drawer is closed; none is left
 *     linked to a closed session outside its count.
 *
 * Skipped when no database is reachable, so `npm test` stays green on a
 * workstation without Postgres. CI provides one.
 */
const prisma = new PrismaClient();
const db: any = prisma;
let reachable = false;
let tenantId: string;
let owner: { id: string; role: string };
let pos: PosService;
let drawer: CashSessionsService;
let payments: PaymentsService;
let serviceId: string;
const run = randomUUID().slice(0, 8);

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
      name: "L2 drawer",
      slug: `l2-drawer-${run}`,
      plan: "pro",
      subscriptionStatus: "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 864e5),
      fiscalSettings: { pricesIncludeTax: true, defaultTaxRate: 21, defaultSeries: "A" },
    },
  });
  tenantId = tenant.id;
  // A real user: the audit log points at its actor.
  const user = await db.user.create({
    data: {
      tenantId,
      email: `l2-drawer-${run}@example.test`,
      firstName: "Ana",
      lastName: "Caja",
      role: "owner",
      passwordHash: "not-a-real-hash",
    },
  });
  owner = { id: user.id, role: "owner" };
  const service = await db.service.create({
    data: { tenantId, name: "Corte", price: 40, duration: 30, isActive: true, category: "hair" },
  });
  serviceId = service.id;
  const fiscal = { dispatchInvoice: jest.fn(async () => undefined) };
  const invoices = new InvoiceService(db, new InvoiceCalculator(), fiscal as any);
  pos = new PosService(db, new WalletService(db), undefined, invoices);
  drawer = new CashSessionsService(db, new AuditLogService(db));
  payments = new PaymentsService(db);
}, 60_000);

afterAll(async () => {
  if (reachable && tenantId) {
    await db.auditLog.deleteMany({ where: { tenantId } }).catch(() => undefined);
    await db.refund.deleteMany({ where: { payment: { tenantId } } }).catch(() => undefined);
    await db.payment.deleteMany({ where: { tenantId } }).catch(() => undefined);
    await db.invoiceLine.deleteMany({ where: { invoice: { tenantId } } }).catch(() => undefined);
    await db.invoice.deleteMany({ where: { tenantId } }).catch(() => undefined);
    await db.user.deleteMany({ where: { tenantId } }).catch(() => undefined);
    await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

const sell = (tenders: Array<{ method: string; amount: number }>) =>
  pos.processCheckout({ tenantId, actor: owner, items: [{ serviceId, quantity: 1 }], payments: tenders } as any);

describe("the cash drawer (L2, real database)", () => {
  it("two 'Abrir caja' at once: one session, the other a 409", async () => {
    if (!reachable) return;
    const results = await Promise.allSettled([
      drawer.open(tenantId, owner, { openingFloatCents: 5000 }),
      drawer.open(tenantId, owner, { openingFloatCents: 5000 }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason.getResponse()).toMatchObject({ code: "CASH_SESSION_ALREADY_OPEN" });
    expect(await db.cashSession.count({ where: { tenantId, status: "open" } })).toBe(1);

    const open = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<any>).value;
    await drawer.close(tenantId, open.id, owner, { countedCashCents: 5000 });
    // Closed: a new one may be opened, and the closed one stays.
    expect(await db.cashSession.count({ where: { tenantId } })).toBe(1);
  }, 60_000);

  it("a day at the till: the close stores expected cash and the difference", async () => {
    if (!reachable) return;
    // The drawer is closed: cash is refused, card still sells (unlinked).
    await expect(sell([{ method: "cash", amount: 4000 }])).rejects.toThrow(/La caja está cerrada/);
    const early = await sell([{ method: "card", amount: 4000 }]);
    expect((await db.posSale.findUnique({ where: { id: early.saleId } })).cashSessionId).toBeNull();

    const session = await drawer.open(tenantId, owner, { openingFloatCents: 10_000 });
    const cash = await sell([{ method: "cash", amount: 5000 }]); // 40 kept, 10 change
    await sell([{ method: "card", amount: 4000 }]);
    await sell([
      { method: "bizum", amount: 1500 },
      { method: "cash", amount: 3000 },
    ]); // 25 kept in cash, 5 change
    const cashPayment = await db.payment.findFirst({ where: { tenantId, method: "cash", metadata: { path: ["posSaleId"], equals: cash.saleId } } });
    expect(cashPayment).toMatchObject({ amount: 4000, cashSessionId: session.id });
    await payments.refundPayment(tenantId, cashPayment.id, { amount: 1000, reason: "Retoque gratis" }, owner.id);
    await drawer.addMovement(tenantId, session.id, owner, { type: "out", amountCents: 2000, reason: "Proveedor" });
    await drawer.addMovement(tenantId, session.id, owner, { type: "in", amountCents: 500, reason: "Cambio" });

    // 100 + 40 + 25 - 10 - 20 + 5 = 140 expected; 139,50 counted.
    const closed = await drawer.close(tenantId, session.id, owner, { countedCashCents: 13_950 });
    expect(closed).toMatchObject({ status: "closed", expectedCashCents: 14_000, countedCashCents: 13_950, discrepancyCents: -50 });
    expect(closed.figures.cash).toMatchObject({
      openingFloatCents: 10_000,
      salesCents: 6500,
      changeGivenCents: 1500,
      tenderedCents: 8000,
      refundsCents: 1000,
      movementsInCents: 500,
      movementsOutCents: 2000,
    });
    expect(closed.figures.byMethod.map((m: any) => [m.method, m.amountCents, m.refundedCents])).toEqual([
      ["cash", 6500, 1000],
      ["card", 4000, 0],
      ["bizum", 1500, 0],
    ]);
    // Three sales of 40 € (IVA 21 % included: 6,94 each).
    expect(closed.figures.sales).toMatchObject({ count: 3, grossCents: 12_000, taxCents: 3 * 694 });
    const stored = await db.cashSession.findUnique({ where: { id: session.id } });
    expect(stored).toMatchObject({ status: "closed", expectedCashCents: 14_000, discrepancyCents: -50, closedById: owner.id });
    const actions = (await db.auditLog.findMany({ where: { tenantId }, select: { action: true } })).map((a: any) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["pos.cash_session.opened", "pos.cash_movement.created", "pos.cash_session.closed"]));

    // After the close the drawer is shut again: no more cash.
    await expect(sell([{ method: "cash", amount: 4000 }])).rejects.toThrow(/La caja está cerrada/);
  }, 120_000);

  it("closing while cash sales are being charged: every recorded cash sale is in the count", async () => {
    if (!reachable) return;
    const session = await drawer.open(tenantId, owner, { openingFloatCents: 0 });
    const sales = Array.from({ length: 6 }, () => sell([{ method: "cash", amount: 4000 }]));
    const close = new Promise((r) => setTimeout(r, 15)).then(() => drawer.close(tenantId, session.id, owner, { countedCashCents: 0 }));
    const results = await Promise.allSettled([...sales, close]);
    const closed = (results[6] as PromiseFulfilledResult<any>).value;
    const sold = results.slice(0, 6).filter((r) => r.status === "fulfilled").length;
    for (const r of results.slice(0, 6)) {
      if (r.status === "rejected") expect(r.reason.message).toMatch(/La caja está cerrada/);
    }
    // What the close counted is exactly the cash recorded in the session.
    const linked = await db.payment.aggregate({ where: { tenantId, cashSessionId: session.id, method: "cash" }, _sum: { amount: true } });
    expect(closed.expectedCashCents).toBe(sold * 4000);
    expect(linked._sum.amount ?? 0).toBe(sold * 4000);
  }, 120_000);
});
