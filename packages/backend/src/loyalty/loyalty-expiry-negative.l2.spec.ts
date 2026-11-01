import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { PosService } from "../pos/pos.service";
import { WalletService } from "../payments/services/wallet.service";
import { PaymentsService } from "../payments/payments.service";
import { LoyaltyService } from "./loyalty.service";
import { InvoiceService } from "../invoices/invoices.service";
import { InvoiceCalculator } from "../invoices/invoice-calculator.service";

/**
 * L2: points that expire, balances that go negative and rewards handed
 * over at the till, against a real database (audit L3, L4, L8, L11).
 *
 *   - The nightly expiry takes the whole balance of a member with no visit
 *     for 12 months, as one "Caducidad" entry per member and day; a member
 *     who came back keeps hers; nothing expires during the grace.
 *   - Earn, spend on a product gift, refund the visit: the balance goes
 *     negative (it used to stop at 0); she cannot redeem; her next visit
 *     pays it off.
 *   - A product reward leaves a zero-price line and a stock movement
 *     ("regalo fidelidad"); "otro regalo" a zero line and no movement.
 *   - The receipt tells her the points earned, her balance and the rule.
 *
 * Skipped when no database is reachable, so `npm test` stays green on a
 * workstation without Postgres. CI provides one.
 */
const prisma = new PrismaClient();
const db: any = prisma;
let reachable = false;
let tenantId: string;
let programId: string;
let loyalty: LoyaltyService;
let pos: PosService;
let payments: PaymentsService;
let serviceId: string;
let productId: string;
let giftProductId: string;
let professionalId: string;
const run = randomUUID().slice(0, 8);
const OWNER = { id: "l2-owner", role: "owner" };
const DAY = 864e5;

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
      name: "L2 loyalty expiry",
      slug: `l2-loyalty-expiry-${run}`,
      plan: "pro",
      subscriptionStatus: "active",
      timezone: "Europe/Madrid",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + DAY),
      fiscalSettings: { pricesIncludeTax: true, defaultTaxRate: 21, defaultSeries: "A" },
    },
  });
  tenantId = tenant.id;
  await db.cashSession.create({ data: { tenantId, openedById: OWNER.id, openingFloatCents: 0 } });
  serviceId = (await db.service.create({ data: { tenantId, name: "Corte", category: "hair", duration: 30, price: 30 } })).id;
  productId = (
    await db.product.create({ data: { tenantId, name: `Mascarilla ${run}`, price: 12, quantity: 50, trackInventory: true, isActive: true } })
  ).id;
  giftProductId = (
    await db.product.create({ data: { tenantId, name: `Champú regalo ${run}`, price: 9, quantity: 5, trackInventory: true, isActive: true } })
  ).id;
  professionalId = (
    await db.professional.create({
      data: { tenantId, firstName: "Pro", lastName: "Fesional", email: `pro-expiry-${run}@example.test`, hireDate: new Date() },
    })
  ).id;
  const program = await db.loyaltyProgram.create({
    data: { tenantId, isActive: true, earnMode: "per_euro", pointsPerEuro: 1, minPointsRedemption: 0 },
  });
  programId = program.id;

  const flags: any = { isFeatureUnlocked: jest.fn(async () => true) };
  loyalty = new LoyaltyService(db, flags);
  const wallet = new WalletService(db);
  const fiscal = { dispatchInvoice: jest.fn(async () => undefined) };
  const invoices = new InvoiceService(db, new InvoiceCalculator(), fiscal as any);
  pos = new PosService(db, wallet, loyalty, invoices);
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

const client = async (firstName: string) => (await db.client.create({ data: { tenantId, firstName, lastName: "Prueba" } })).id as string;
const member = (clientId: string) => db.loyaltyMember.findFirst({ where: { clientId, programId } });
const points = async (clientId: string) => (await member(clientId)).currentPoints as number;

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

/** Today at noon UTC: past 03:00 in Madrid whatever the season. */
const noonToday = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12));
};

describe("loyalty points expire after 12 months without a visit (L2, real database)", () => {
  it("the nightly run takes the whole balance of an inactive member, once, and leaves the others", async () => {
    if (!reachable) return;
    const now = noonToday();
    await db.loyaltyProgram.update({ where: { id: programId }, data: { pointsExpirationDays: 365, pointsExpiryStartsAt: null } });
    const ana = await client("Ana");
    const bea = await client("Bea");
    await loyalty.enroll(tenantId, ana, "staff");
    await loyalty.enroll(tenantId, bea, "staff");
    await db.loyaltyMember.updateMany({
      where: { clientId: ana },
      data: { currentPoints: 140, lifetimePoints: 140, peakLifetimePoints: 140, pointsRenewedAt: new Date(now.getTime() - 400 * DAY) },
    });
    await db.loyaltyMember.updateMany({
      where: { clientId: bea },
      data: { currentPoints: 90, lifetimePoints: 90, peakLifetimePoints: 90, pointsRenewedAt: new Date(now.getTime() - 200 * DAY) },
    });

    // During the grace, nothing.
    await db.loyaltyProgram.update({ where: { id: programId }, data: { pointsExpiryStartsAt: new Date(now.getTime() + 10 * DAY) } });
    await loyalty.expireInactivePoints(now);
    expect(await points(ana)).toBe(140);

    await db.loyaltyProgram.update({ where: { id: programId }, data: { pointsExpiryStartsAt: new Date(now.getTime() - DAY) } });
    await loyalty.expireInactivePoints(now);
    expect(await points(ana)).toBe(0);
    expect(await points(bea)).toBe(90);
    expect((await db.client.findUnique({ where: { id: ana } })).loyaltyPoints).toBe(0);
    // The level's points stay.
    expect((await member(ana)).lifetimePoints).toBe(140);
    const expired = await db.loyaltyTransaction.findMany({ where: { tenantId, type: "expire" } });
    expect(expired).toHaveLength(1);
    expect(expired[0]).toMatchObject({ points: -140, source: "expiry", description: "Caducidad" });

    // A second run the same day (another tick, another instance): nothing more.
    await db.loyaltyMember.updateMany({ where: { clientId: ana }, data: { currentPoints: 5 } });
    await loyalty.expireInactivePoints(new Date(now.getTime() + 3600e3));
    expect(await points(ana)).toBe(5);
    expect(await db.loyaltyTransaction.count({ where: { tenantId, type: "expire" } })).toBe(1);
  }, 60_000);

  it("a paid visit at the till renews all her points", async () => {
    if (!reachable) return;
    const cris = await client("Cris");
    await loyalty.enroll(tenantId, cris, "staff");
    await db.loyaltyMember.updateMany({
      where: { clientId: cris },
      data: { currentPoints: 70, pointsRenewedAt: new Date(Date.now() - 360 * DAY) },
    });
    const a = await visit(cris, { completionTime: new Date() });
    await pos.processCheckout({
      tenantId,
      actor: OWNER,
      clientId: cris,
      appointmentIds: [a.id],
      payments: [{ method: "card", amount: 3000 }],
    } as any);
    const m = await member(cris);
    expect(m.currentPoints).toBe(100);
    expect(Date.now() - new Date(m.pointsRenewedAt).getTime()).toBeLessThan(DAY);
    await loyalty.expireInactivePoints(new Date(noonToday().getTime() + 10 * DAY));
    expect(await points(cris)).toBe(100);
  }, 60_000);
});

describe("a negative balance and rewards handed over at the till (L2, real database)", () => {
  it("earn, spend on a product gift, refund the visit: negative, no redeeming, paid off by the next visit", async () => {
    if (!reachable) return;
    const dora = await client("Dora");
    const gift = await loyalty.createReward(tenantId, {
      name: "Champú de regalo",
      type: "product",
      pointsCost: 25,
      productId: giftProductId,
    } as any);

    // 1. A visit: +30.
    await loyalty.enroll(tenantId, dora, "staff");
    const a = await visit(dora);
    const first: any = await pos.processCheckout({
      tenantId,
      actor: OWNER,
      clientId: dora,
      appointmentIds: [a.id],
      payments: [{ method: "card", amount: 3000 }],
    } as any);
    expect(first.loyalty.pointsEarned).toBe(30);
    expect(await points(dora)).toBe(30);

    // 2. A mascarilla, and the gift for 25 points: a zero line, one unit out of stock.
    const second: any = await pos.processCheckout({
      tenantId,
      actor: OWNER,
      clientId: dora,
      items: [{ productId, quantity: 1 }],
      loyaltyRewardId: gift.id,
      payments: [{ method: "card", amount: 1200 }],
    } as any);
    expect(second.loyalty).toMatchObject({ pointsSpent: 25, pointsEarned: 12 });
    expect(await points(dora)).toBe(17);
    const lines = await db.posSaleLine.findMany({ where: { saleId: second.saleId }, orderBy: { lineIndex: "asc" } });
    const giftLine = lines.find((l: any) => l.kind === "loyalty_gift");
    expect(giftLine).toMatchObject({ productId: giftProductId, unitPriceCents: 0, totalCents: 0, taxCents: 0, quantity: 1 });
    expect(giftLine.description).toBe(`Regalo fidelidad: Champú regalo ${run}`);
    expect((await db.product.findUnique({ where: { id: giftProductId } })).quantity).toBe(4);
    const movement = await db.inventoryTransaction.findFirst({ where: { tenantId, productId: giftProductId } });
    expect(movement).toMatchObject({ quantity: -1, previousQty: 5, newQty: 4, reason: "regalo fidelidad" });
    // On the invoice as a zero line, beside the mascarilla (same rate).
    const invoice = await db.invoice.findFirst({ where: { tenantId, sourceId: second.saleId }, include: { lines: true } });
    expect(invoice.totalCents).toBe(1200);
    expect(invoice.lines.map((l: any) => [l.description, l.totalCents])).toContainEqual([giftLine.description, 0]);

    // The receipt: what she earned, her balance and the rule.
    const receipt: any = await pos.getReceipt(tenantId, second.saleId, OWNER as any);
    expect(receipt.loyalty).toEqual({
      pointsEarned: 12,
      balance: 17,
      expiryRule: "Tus puntos caducan si pasan 12 meses sin visitas",
    });
    expect(receipt.taxBreakdown).toHaveLength(1);

    // 3. The visit refunded in full: all 30 back, the balance below zero.
    const visitRow = (await db.payment.findMany({ where: { tenantId, appointmentId: a.id } }))[0];
    await payments.refundPayment(tenantId, visitRow.id, { reason: "Devolución" } as any, OWNER.id);
    expect(await points(dora)).toBe(-13);
    expect((await db.client.findUnique({ where: { id: dora } })).loyaltyPoints).toBe(-13);

    // She cannot redeem, not even a cheap reward; nothing is spent.
    const cheap = await loyalty.createReward(tenantId, { name: "Vale", type: "voucher", pointsCost: 1 } as any);
    await expect(
      pos.processCheckout({
        tenantId,
        actor: OWNER,
        clientId: dora,
        items: [{ productId, quantity: 1 }],
        loyaltyRewardId: cheap.id,
        payments: [{ method: "card", amount: 1200 }],
      } as any),
    ).rejects.toThrow(/saldo de puntos negativo/);
    expect(await points(dora)).toBe(-13);

    // 4. Her next visit pays it off.
    const b = await visit(dora);
    await pos.processCheckout({
      tenantId,
      actor: OWNER,
      clientId: dora,
      appointmentIds: [b.id],
      payments: [{ method: "card", amount: 3000 }],
    } as any);
    expect(await points(dora)).toBe(17);
  }, 90_000);

  it("«otro regalo»: a zero line with its description and no stock movement", async () => {
    if (!reachable) return;
    const eva = await client("Eva");
    await loyalty.enroll(tenantId, eva, "staff");
    await db.loyaltyMember.updateMany({ where: { clientId: eva }, data: { currentPoints: 50 } });
    const reward = await loyalty.createReward(tenantId, {
      name: "Neceser",
      description: "Neceser de viaje",
      type: "voucher",
      pointsCost: 40,
    } as any);
    const movementsBefore = await db.inventoryTransaction.count({ where: { tenantId } });
    const sale: any = await pos.processCheckout({
      tenantId,
      actor: OWNER,
      clientId: eva,
      items: [{ productId, quantity: 1 }],
      loyaltyRewardId: reward.id,
      payments: [{ method: "cash", amount: 1200 }],
    } as any);
    const line = await db.posSaleLine.findFirst({ where: { saleId: sale.saleId, kind: "loyalty_gift" } });
    expect(line).toMatchObject({ productId: null, totalCents: 0, description: "Regalo fidelidad: Neceser de viaje" });
    // Only the mascarilla's own movement.
    expect(await db.inventoryTransaction.count({ where: { tenantId } })).toBe(movementsBefore + 1);
    expect(await points(eva)).toBe(50 - 40 + 12);
  }, 60_000);
});
