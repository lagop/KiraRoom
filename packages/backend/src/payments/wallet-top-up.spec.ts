import { ConflictException } from "@nestjs/common";
import { WalletService } from "./services/wallet.service";

/**
 * A wallet top-up records how the client paid it and, when cash, needs the
 * cash drawer open (the till's 409 CASH_SESSION_CLOSED) and counts in it.
 * It writes no Payment: the money is a prepayment, recognised as revenue
 * when the wallet is spent. The drawer's side (expected cash, the report by
 * method): cash-session-math.spec.ts, cash-sessions.spec.ts and, against a
 * real database, cash-sessions.l2.spec.ts.
 */

const T = "t1";
const CLIENT = "c1";
const OWNER = { id: "u-owner", role: "owner" };

function memory(openSessionId: string | null) {
  const state = { balance: 0, transactions: [] as any[], locks: [] as string[] };
  const audit = { record: jest.fn(async () => ({ id: "a1" })) };
  const tx: any = {
    $queryRaw: jest.fn(async (sql: any) => {
      state.locks.push(String(sql.sql));
      return openSessionId ? [{ id: openSessionId }] : [];
    }),
    clientWallet: {
      upsert: jest.fn(async () => ({ id: "w1", tenantId: T, balance: state.balance })),
      update: jest.fn(async ({ data }: any) => {
        state.balance += data.balance.increment;
        return { id: "w1", tenantId: T, balance: state.balance };
      }),
    },
    walletTransaction: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `wt${state.transactions.length + 1}`, ...data };
        state.transactions.push(row);
        return row;
      }),
    },
    payment: { create: jest.fn() },
  };
  const prisma: any = { $transaction: jest.fn(async (fn: any) => fn(tx)) };
  return { state, tx, audit, wallet: new WalletService(prisma, audit as any) };
}

describe("wallet top-ups", () => {
  it("cash with the drawer closed: the till's 409, nothing loaded", async () => {
    const t = memory(null);
    const err = await t.wallet.topUp(T, CLIENT, 2000, "cash", OWNER).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "CASH_SESSION_CLOSED" });
    expect(t.state.balance).toBe(0);
    expect(t.state.transactions).toHaveLength(0);
    expect(t.audit.record).not.toHaveBeenCalled();
  });

  it("cash with the drawer open: linked to it, held FOR SHARE so it cannot close meanwhile", async () => {
    const t = memory("cs1");
    const out = await t.wallet.topUp(T, CLIENT, 2000, "cash", OWNER);
    expect(t.state.locks[0]).toMatch(/FROM "cash_sessions".*FOR SHARE/);
    expect(out.transaction).toMatchObject({
      type: "credit",
      amount: 2000,
      balanceAfter: 2000,
      method: "cash",
      cashSessionId: "cs1",
      recordedById: OWNER.id,
      referenceType: "top_up",
      description: "Recarga en efectivo",
    });
    expect(t.audit.record).toHaveBeenCalledWith(
      "payments.wallet.top_up",
      expect.objectContaining({
        actorId: OWNER.id,
        tenantId: T,
        metadata: expect.objectContaining({ clientId: CLIENT, amount: 2000, method: "cash", cashSessionId: "cs1" }),
      }),
      t.tx,
    );
  });

  it("card, Bizum and transfer go with the drawer closed (unlinked) and with it open (linked)", async () => {
    const closed = memory(null);
    await closed.wallet.topUp(T, CLIENT, 1000, "card", OWNER);
    await closed.wallet.topUp(T, CLIENT, 1000, "bizum", OWNER, "  Bono verano ");
    await closed.wallet.topUp(T, CLIENT, 1000, "bank_transfer", OWNER);
    expect(closed.state.transactions.map((r) => [r.method, r.cashSessionId, r.description])).toEqual([
      ["card", null, "Recarga con tarjeta"],
      ["bizum", null, "Bono verano"],
      ["bank_transfer", null, "Recarga por transferencia"],
    ]);
    const open = memory("cs1");
    await open.wallet.topUp(T, CLIENT, 1000, "card", OWNER);
    expect(open.state.transactions[0]).toMatchObject({ method: "card", cashSessionId: "cs1" });
  });

  it("writes no payment: a top-up is not revenue until the wallet is spent", async () => {
    const t = memory("cs1");
    await t.wallet.topUp(T, CLIENT, 5000, "cash", OWNER);
    expect(t.tx.payment.create).not.toHaveBeenCalled();
  });

  it("other credits (a refund back to the wallet) carry no tender", async () => {
    const t = memory("cs1");
    await t.wallet.creditIn(t.tx, T, CLIENT, 700, "Devolución: x", "refund", "r1");
    expect(t.state.transactions[0]).not.toHaveProperty("method");
    expect(t.state.transactions[0]).not.toHaveProperty("cashSessionId");
  });
});
