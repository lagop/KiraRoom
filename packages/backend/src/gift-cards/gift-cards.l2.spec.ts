import { PrismaClient } from "@prisma/client";
import { randomUUID } from "crypto";
import { GiftCardsService } from "./gift-cards.service";

/**
 * L2: gift card balances under concurrent use, against a real database.
 *
 * Redemption used to read the balance and then write a new one, so two
 * tills spending the same card at once both passed the check: a 50 € card
 * paid 100 €, and concurrent partial redemptions lost each other's updates.
 *
 * Skipped when no database is reachable, so `npm test` stays green on a
 * workstation without Postgres. CI provides one.
 */
const prisma = new PrismaClient();
const db: any = prisma;
let reachable = false;
let tenantId: string;
let service: GiftCardsService;
const email = { sendEmail: jest.fn(async () => ({ success: true })) };

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
      name: "L2 gift cards",
      slug: `l2-gift-cards-${run}`,
      plan: "pro",
      subscriptionStatus: "active",
      currentPeriodStart: new Date(),
      currentPeriodEnd: new Date(Date.now() + 864e5),
    },
  });
  tenantId = tenant.id;
  service = new GiftCardsService(db, email as any);
}, 60_000);

afterAll(async () => {
  if (reachable && tenantId) {
    await db.tenant.delete({ where: { id: tenantId } }).catch(() => undefined);
  }
  await prisma.$disconnect();
});

const card = (initialAmount: number, over: any = {}) =>
  service.create(tenantId, { initialAmount, ...over } as any);

const redeem = (giftCardId: string, amountCents: number, paymentId?: string) =>
  prisma.$transaction((tx) => service.redeemInTx(tx, { tenantId, giftCardId, amountCents, paymentId }));

async function ledger(id: string) {
  const c = await db.giftCard.findUnique({ where: { id }, include: { transactions: true } });
  const total = (type: string) =>
    c.transactions.filter((t: any) => t.type === type).reduce((s: number, t: any) => s + t.amount, 0);
  return { balance: c.currentBalance, applied: total("applied"), refunded: total("refunded"), rows: c.transactions };
}

const fulfilled = (results: PromiseSettledResult<unknown>[]) => results.filter((r) => r.status === "fulfilled").length;

describe("gift cards (L2, real database)", () => {
  it("two tills spending the whole card at once: one wins, the other is refused", async () => {
    if (!reachable) return;
    const c = await card(5000);
    const results = await Promise.allSettled([redeem(c.id, 5000), redeem(c.id, 5000)]);
    expect(fulfilled(results)).toBe(1);
    const rejected = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason.message).toBe("La tarjeta regalo no tiene saldo");
    expect(await ledger(c.id)).toMatchObject({ balance: 0, applied: 5000 });
  });

  it("five 20 € redemptions at once on a 50 € card: exactly two go through", async () => {
    if (!reachable) return;
    const c = await card(5000);
    const results = await Promise.allSettled(Array.from({ length: 5 }, () => redeem(c.id, 2000)));
    expect(fulfilled(results)).toBe(2);
    const l = await ledger(c.id);
    expect(l).toMatchObject({ balance: 1000, applied: 4000 });
    const after = l.rows.filter((t: any) => t.type === "applied").map((t: any) => t.balanceAfter).sort();
    expect(after).toEqual([1000, 3000]);
  });

  it("ten small redemptions at once lose no update", async () => {
    if (!reachable) return;
    const c = await card(5000);
    const results = await Promise.allSettled(Array.from({ length: 10 }, () => redeem(c.id, 500)));
    expect(fulfilled(results)).toBe(10);
    const l = await ledger(c.id);
    expect(l).toMatchObject({ balance: 0, applied: 5000 });
    // Every movement saw a distinct balance: they were serialised, not overlapped.
    const after = new Set(l.rows.filter((t: any) => t.type === "applied").map((t: any) => t.balanceAfter));
    expect(after.size).toBe(10);
  });

  it("a sale that fails after redeeming rolls the card back", async () => {
    if (!reachable) return;
    const c = await card(5000);
    await expect(
      prisma.$transaction(async (tx) => {
        await service.redeemInTx(tx, { tenantId, giftCardId: c.id, amountCents: 2000 });
        throw new Error("payment failed");
      }),
    ).rejects.toThrow("payment failed");
    expect(await ledger(c.id)).toMatchObject({ balance: 5000, applied: 0 });
  });

  it("concurrent refunds of one payment never give back more than it took", async () => {
    if (!reachable) return;
    const c = await card(5000);
    const paymentId = randomUUID();
    await redeem(c.id, 3000, paymentId);
    const results = await Promise.allSettled(
      Array.from({ length: 3 }, () =>
        prisma.$transaction((tx) =>
          service.refundToCard(tx, { tenantId, giftCardId: c.id, amountCents: 2000, paymentId }),
        ),
      ),
    );
    expect(fulfilled(results)).toBe(1);
    expect(await ledger(c.id)).toMatchObject({ balance: 4000, applied: 3000, refunded: 2000 });
  });

  it("a card valid until today still works today", async () => {
    if (!reachable) return;
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());
    const c = await card(5000, { expiresAt: today });
    await expect(redeem(c.id, 100)).resolves.toBeTruthy();
  });
});
