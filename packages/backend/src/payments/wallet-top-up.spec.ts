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

function memory(openSessionId: string | null, balance = 0) {
  const state = { balance, transactions: [] as any[], locks: [] as string[] };
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
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (state.balance < where.balance.gte) return { count: 0 };
        state.balance -= data.balance.decrement;
        return { count: 1 };
      }),
      findUnique: jest.fn(async () => ({ balance: state.balance })),
      findUniqueOrThrow: jest.fn(async () => ({ id: "w1", tenantId: T, balance: state.balance })),
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

describe("wallet withdrawals (money handed back from the wallet)", () => {
  it("cash with the drawer closed: the 409, the balance untouched", async () => {
    const t = memory(null, 5000);
    const err = await t.wallet.withdraw(T, CLIENT, 2000, "cash", OWNER).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "CASH_SESSION_CLOSED", message: expect.stringMatching(/devolver en efectivo/) });
    expect(t.state.balance).toBe(5000);
    expect(t.state.transactions).toHaveLength(0);
    expect(t.audit.record).not.toHaveBeenCalled();
  });

  it("cash with the drawer open: linked to it under FOR SHARE, with the tender and who, audit-logged", async () => {
    const t = memory("cs1", 5000);
    const out = await t.wallet.withdraw(T, CLIENT, 2000, "cash", OWNER);
    expect(t.state.locks[0]).toMatch(/FROM "cash_sessions".*FOR SHARE/);
    expect(t.state.balance).toBe(3000);
    expect(out.transaction).toMatchObject({
      type: "debit",
      amount: 2000,
      balanceAfter: 3000,
      method: "cash",
      cashSessionId: "cs1",
      recordedById: OWNER.id,
      referenceType: "withdrawal",
      description: "Retirada en efectivo",
    });
    expect(t.audit.record).toHaveBeenCalledWith(
      "payments.wallet.withdrawal",
      expect.objectContaining({ metadata: expect.objectContaining({ clientId: CLIENT, amount: 2000, method: "cash", cashSessionId: "cs1" }) }),
      t.tx,
    );
  });

  it("card, Bizum and transfer go with the drawer closed (unlinked)", async () => {
    const t = memory(null, 5000);
    await t.wallet.withdraw(T, CLIENT, 1000, "card", OWNER);
    await t.wallet.withdraw(T, CLIENT, 1000, "bizum", OWNER, " Se muda ");
    await t.wallet.withdraw(T, CLIENT, 1000, "bank_transfer", OWNER);
    expect(t.state.transactions.map((r) => [r.method, r.cashSessionId, r.description])).toEqual([
      ["card", null, "Retirada a tarjeta"],
      ["bizum", null, "Se muda"],
      ["bank_transfer", null, "Retirada por transferencia"],
    ]);
    expect(t.state.balance).toBe(2000);
  });

  it("never past the balance: refused, nothing recorded or audit-logged", async () => {
    const t = memory("cs1", 1000);
    await expect(t.wallet.withdraw(T, CLIENT, 1500, "card", OWNER)).rejects.toThrow(/Saldo insuficiente/);
    expect(t.state.balance).toBe(1000);
    expect(t.state.transactions).toHaveLength(0);
    expect(t.audit.record).not.toHaveBeenCalled();
    expect(t.tx.payment.create).not.toHaveBeenCalled();
  });

  it("a wallet payment at the till (debitIn without a tender) carries none", async () => {
    const t = memory("cs1", 1000);
    await t.wallet.debitIn(t.tx, T, CLIENT, 400, "Pago en caja", "pos_sale", "s1");
    expect(t.state.transactions[0]).not.toHaveProperty("method");
  });
});
