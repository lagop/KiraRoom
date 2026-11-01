import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { PosService } from "../pos/pos.service";
import { WalletService } from "../payments/services/wallet.service";
import { PaymentsService } from "../payments/payments.service";
import { LoyaltyService } from "./loyalty.service";

/**
 * L2: loyalty points through the real till and the real refunds, against a
 * real database (audit L1, L2, L5).
 *
 *   - Refunding a shampoo off a visit's ticket takes back the shampoo's
 *     points only (every row used to carry all the ticket's visits, and
 *     any refund reversed them all).
 *   - A visit paid card + cash: refunding the card takes back half; the
 *     visit loses the rest only once it is refunded in full.
 *   - Mother and daughter on one ticket: the daughter's refund never
 *     touches the mother's points.
 *   - The products on a visit's ticket earn (they used to earn nothing).
 *   - A visit earns on all its money once it is paid in full, not on its
 *     first partial payment.
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
let serviceId: string;
let productId: string;
let professionalId: string;
let mum: string;
let kid: string;
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
      name: "L2 loyalty refunds",
      slug: `l2-loyalty-${run}`,
      plan: "pro",
      subscriptionStatus: "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 864e5),
      fiscalSettings: { pricesIncludeTax: true, defaultTaxRate: 21, defaultSeries: "A" },
    },
  });
  tenantId = tenant.id;
  await db.cashSession.create({ data: { tenantId, openedById: OWNER.id, openingFloatCents: 0 } });
  serviceId = (await db.service.create({ data: { tenantId, name: "Corte", category: "hair", duration: 30, price: 30 } })).id;
  productId = (
    await db.product.create({ data: { tenantId, name: `Champú ${run}`, price: 12, quantity: 50, trackInventory: true, isActive: true } })
  ).id;
  professionalId = (
    await db.professional.create({
      data: { tenantId, firstName: "Pro", lastName: "Fesional", email: `pro-loyalty-${run}@example.test`, hireDate: new Date() },
    })
  ).id;
  mum = (await db.client.create({ data: { tenantId, firstName: "Madre", lastName: "Prueba" } })).id;
  kid = (await db.client.create({ data: { tenantId, firstName: "Hija", lastName: "Prueba" } })).id;
  const program = await db.loyaltyProgram.create({
    data: { tenantId, isActive: true, earnMode: "per_euro", pointsPerEuro: 1, minPointsRedemption: 0 },
  });
  for (const clientId of [mum, kid]) {
    await db.loyaltyMember.create({ data: { clientId, programId: program.id, status: "active" } });
  }

  const flags: any = { isFeatureUnlocked: jest.fn(async () => true) };
  const loyalty = new LoyaltyService(db, flags);
  const wallet = new WalletService(db);
  pos = new PosService(db, wallet, loyalty);
  payments = new PaymentsService(db, loyalty, wallet);
}, 60_000);

afterAll(async () => {
  if (reachable && tenantId) {
    const where = { tenantId };
    await db.payment.deleteMany({ where }).catch(() => undefined);
    await db.appointment.deleteMany({ where }).catch(() => undefined);
    await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

const points = async (clientId: string) =>
  (await db.loyaltyMember.findFirst({ where: { clientId } })).currentPoints as number;

const visit = (clientId: string, over: Record<string, unknown> = {}) =>
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
      price: 30,
      totalAmount: 3000,
      status: "completed",
      ...over,
    },
  });

const rowsOf = (saleId: string) =>
  db.payment.findMany({ where: { tenantId, metadata: { path: ["posSaleId"], equals: saleId } }, orderBy: { createdAt: "asc" } });

const refund = (paymentId: string, amount?: number) =>
  payments.refundPayment(tenantId, paymentId, { reason: "Devolución", ...(amount ? { amount } : {}) }, OWNER.id);

describe("loyalty points and refunds through the till (L2, real database)", () => {
  it("a shampoo refunded off a visit's ticket takes back the shampoo's points, never the visit's", async () => {
    if (!reachable) return;
    const start = await points(mum);
    const a = await visit(mum);
    const sale: any = await pos.processCheckout({
      tenantId,
      actor: OWNER,
      clientId: mum,
      appointmentIds: [a.id],
      items: [{ productId, quantity: 1 }],
      payments: [{ method: "card", amount: 4200 }],
    } as any);
    // 30 for the visit, 12 for the shampoo: products on a visit's ticket earn now.
    expect(sale.loyalty.pointsEarned).toBe(42);
    expect(await points(mum)).toBe(start + 42);

    const shampoo = (await rowsOf(sale.saleId)).find((p: any) => p.type === "product");
    expect(shampoo.amount).toBe(1200);
    await refund(shampoo.id);
    expect(await points(mum)).toBe(start + 30);
    const reversals = await db.loyaltyTransaction.findMany({ where: { tenantId, type: "reversal", metadata: { path: ["posSaleId"], equals: sale.saleId } } });
    expect(reversals.map((t: any) => [t.source, t.points])).toEqual([["refund", -12]]);
    expect(await db.loyaltyTransaction.count({ where: { tenantId, type: "reversal", source: "appointment", sourceId: a.id } })).toBe(0);
  }, 60_000);

  it("card + cash: the card's refund takes back its half; the visit is reversed only when nothing of it is left paid", async () => {
    if (!reachable) return;
    const start = await points(mum);
    const a = await visit(mum);
    const sale: any = await pos.processCheckout({
      tenantId,
      actor: OWNER,
      clientId: mum,
      appointmentIds: [a.id],
      payments: [
        { method: "card", amount: 1500 },
        { method: "cash", amount: 1500 },
      ],
    } as any);
    expect(await points(mum)).toBe(start + 30);
    const rows = await rowsOf(sale.saleId);
    const card = rows.find((p: any) => p.method === "card");
    const cash = rows.find((p: any) => p.method === "cash");
    expect([card.appointmentId, cash.appointmentId]).toEqual([a.id, a.id]);

    await refund(card.id);
    expect(await points(mum)).toBe(start + 15);
    expect((await db.appointment.findUnique({ where: { id: a.id } })).paymentStatus).toBe("paid");

    // Part of the cash, then the rest: each its share, 30 in all, never more.
    await refund(cash.id, 500);
    expect(await points(mum)).toBe(start + 10);
    await refund(cash.id);
    expect((await db.appointment.findUnique({ where: { id: a.id } })).paymentStatus).toBe("refunded");
    expect(await points(mum)).toBe(start);
    const ledger = await db.loyaltyTransaction.findMany({
      where: { tenantId, OR: [{ sourceId: a.id }, { metadata: { path: ["appointmentId"], equals: a.id } }] },
    });
    expect(ledger.reduce((s: number, t: any) => s + t.points, 0)).toBe(0);
  }, 60_000);

  it("mother and daughter on one ticket: the daughter's refund never touches the mother's points", async () => {
    if (!reachable) return;
    const [mumStart, kidStart] = [await points(mum), await points(kid)];
    const am = await visit(mum);
    const ak = await visit(kid, { totalAmount: 2500, price: 25 });
    const sale: any = await pos.processCheckout({
      tenantId,
      actor: OWNER,
      clientId: mum,
      appointmentIds: [am.id, ak.id],
      payments: [{ method: "card", amount: 5500 }],
    } as any);
    expect([await points(mum), await points(kid)]).toEqual([mumStart + 30, kidStart + 25]);

    const kids = (await rowsOf(sale.saleId)).find((p: any) => p.appointmentId === ak.id);
    expect(kids.clientId).toBe(kid);
    await refund(kids.id);
    expect([await points(mum), await points(kid)]).toEqual([mumStart + 30, kidStart]);
  }, 60_000);

  it("a visit paid in two goes earns once, on all its money, when it is paid in full", async () => {
    if (!reachable) return;
    const start = await points(mum);
    // 10,00 paid ahead (a deposit recorded on the payments screen).
    const a = await visit(mum, { amountPaid: 1000 });
    await payments.createPayment(tenantId, null, {
      clientId: mum,
      appointmentId: a.id,
      amount: 1000,
      method: "card",
      type: "deposit",
      status: "paid",
    });
    // Partly paid: no points yet (it used to earn 10 here, once, for good).
    expect(await points(mum)).toBe(start);

    await pos.processCheckout({
      tenantId,
      actor: OWNER,
      clientId: mum,
      appointmentIds: [a.id],
      payments: [{ method: "card", amount: 2000 }],
    } as any);
    expect((await db.appointment.findUnique({ where: { id: a.id } })).paymentStatus).toBe("paid");
    expect(await points(mum)).toBe(start + 30);
  }, 60_000);
});
