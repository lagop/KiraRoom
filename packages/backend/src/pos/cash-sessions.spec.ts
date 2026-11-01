import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ROLES_KEY, SALON_MANAGERS, SALON_TEAM } from "../auth/decorators/roles.decorator";
import { bodyMetatype, bodyParser } from "../common/validation/validated-body.testing";
import { CashSessionsController } from "./cash-sessions.controller";
import { CashSessionsService, type CashSessionFullView } from "./cash-sessions.service";
import { CashMovementDto, CloseCashSessionDto, OpenCashSessionDto } from "./dto/cash-session.dto";
import { PosService } from "./pos.service";
import { OPEN_CASH_SESSION, saleTables, salonTenant } from "./pos-test-kit.testing";

/**
 * The cash drawer (arqueo): opening, money in and out, closing with the
 * count, who sees what, and the till's rule that cash needs the drawer open.
 * Race-free closing against a real database: cash-sessions.l2.spec.ts.
 */

type Row = Record<string, any>;
const T = "t1";
const OWNER = { id: "u-owner", role: "owner" };
const STAFF = { id: "u-staff", role: "staff" };
const OTHER_STAFF = { id: "u-other", role: "staff" };

/** An in-memory drawer: sessions, the rows linked to them and the raw lock query. */
function drawer(
  seed: { sessions?: Row[]; payments?: Row[]; refunds?: Row[]; sales?: Row[]; movements?: Row[]; walletTx?: Row[] } = {},
) {
  const sessions: Row[] = seed.sessions ?? [];
  const movements: Row[] = seed.movements ?? [];
  const payments: Row[] = seed.payments ?? [];
  const refunds: Row[] = seed.refunds ?? [];
  const sales: Row[] = seed.sales ?? [];
  const walletTx: Row[] = seed.walletTx ?? [];
  const locks: string[] = [];
  const audit = { record: jest.fn(async () => ({ id: "a1" })) };
  const prisma: any = {
    $queryRaw: jest.fn(async (sql: any) => {
      locks.push(String(sql.sql));
      const open = sessions.find((s) => s.tenantId === sql.values[0] && s.status === "open");
      return open ? [{ id: open.id }] : [];
    }),
    cashSession: {
      findFirst: jest.fn(async ({ where, orderBy }: any) => {
        const rows = sessions.filter(
          (s) =>
            s.tenantId === where.tenantId && (!where.id || s.id === where.id) && (!where.status || s.status === where.status),
        );
        if (orderBy?.closedAt === "desc") rows.sort((a, b) => b.closedAt - a.closedAt);
        return rows[0] ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        if (sessions.some((s) => s.tenantId === data.tenantId && s.status === "open")) {
          throw Object.assign(new Error("Unique constraint failed"), { code: "P2002" });
        }
        const row = { id: `cs${sessions.length + 1}`, status: "open", openedAt: new Date(), closedById: null, ...data };
        sessions.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(sessions.find((s) => s.id === where.id)!, data)),
    },
    cashMovement: {
      findMany: jest.fn(async ({ where }: any) =>
        movements.filter((m) => m.sessionId === where.sessionId && (!where.createdById || m.createdById === where.createdById)),
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `m${movements.length + 1}`, createdAt: new Date(), ...data };
        movements.push(row);
        return row;
      }),
    },
    payment: { findMany: jest.fn(async ({ where }: any) => payments.filter((p) => p.cashSessionId === where.cashSessionId)) },
    refund: {
      findMany: jest.fn(async ({ where }: any) =>
        refunds.filter((r) => r.cashSessionId === where.cashSessionId).map((r) => ({ amount: r.amount, payment: { method: r.method } })),
      ),
    },
    posSale: { findMany: jest.fn(async ({ where }: any) => sales.filter((s) => s.cashSessionId === where.cashSessionId)) },
    walletTransaction: {
      findMany: jest.fn(async ({ where }: any) =>
        walletTx.filter(
          (w) => w.cashSessionId === where.cashSessionId && w.type === where.type && w.method != null && w.tenantId === where.wallet.tenantId,
        ),
      ),
    },
    posSaleLine: { aggregate: jest.fn(async () => ({ _sum: { taxCents: 0 } })) },
    tenant: { findUnique: jest.fn(async () => ({ name: "Salón Prueba", timezone: "Europe/Madrid" })) },
    user: {
      findMany: jest.fn(async ({ where }: any) =>
        where.id.in.map((id: string) => ({ id, firstName: id === "u-staff" ? "Lucía" : "Ana", lastName: "Prueba" })),
      ),
    },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  return { prisma, sessions, movements, locks, audit, service: new CashSessionsService(prisma, audit as any) };
}

const openSession = (over: Row = {}): Row => ({
  id: "cs1",
  tenantId: T,
  status: "open",
  openedById: STAFF.id,
  openedAt: new Date("2026-11-01T08:00:00Z"),
  openingFloatCents: 10_000,
  ...over,
});

describe("opening the drawer", () => {
  it("opens with the float, audit-logged in the same transaction", async () => {
    const t = drawer();
    const out = await t.service.open(T, STAFF, { openingFloatCents: 15_000, notes: " cambio del lunes " });
    expect(t.sessions[0]).toMatchObject({ tenantId: T, openedById: STAFF.id, openingFloatCents: 15_000, openingNotes: "cambio del lunes" });
    // Staff count blind: the float they put in, never what the drawer should hold.
    expect(out).toMatchObject({ blind: true, status: "open", openingFloatCents: 15_000, openedBy: { name: "Lucía Prueba" } });
    expect(out).not.toHaveProperty("expectedCashCents");
    expect(t.audit.record).toHaveBeenCalledWith(
      "pos.cash_session.opened",
      expect.objectContaining({ actorId: STAFF.id, tenantId: T, metadata: { sessionId: "cs1", openingFloatCents: 15_000 } }),
      t.prisma,
    );
  });

  it("one open session per salon: a second one is a 409 (the database's partial unique index)", async () => {
    const t = drawer({ sessions: [openSession()] });
    const err = await t.service.open(T, OWNER, { openingFloatCents: 0 }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "CASH_SESSION_ALREADY_OPEN" });
    expect(t.sessions).toHaveLength(1);
  });

  it("current: the open session with its live figures, or the last count to start from", async () => {
    const t = drawer({ sessions: [openSession({ status: "closed", closedAt: new Date(1), countedCashCents: 12_345 })] });
    expect(await t.service.current(T, STAFF)).toMatchObject({
      session: null,
      lastClosed: { id: "cs1", closedAt: new Date(1), countedCashCents: 12_345 },
      canSeeHistory: false,
    });
    const open = drawer({ sessions: [openSession()], payments: [{ cashSessionId: "cs1", method: "cash", amount: 2500 }] });
    const now = await open.service.current(T, OWNER);
    expect(now.canSeeHistory).toBe(true);
    expect(now.session).toMatchObject({ blind: false, id: "cs1", expectedCashCents: 12_500 });
  });
});

describe("closing the drawer", () => {
  function closing() {
    return drawer({
      sessions: [openSession()],
      payments: [
        { cashSessionId: "cs1", method: "cash", amount: 4000 },
        { cashSessionId: "cs1", method: "card", amount: 6000 },
        { cashSessionId: "cs1", method: "cash", amount: 2000 },
      ],
      refunds: [{ cashSessionId: "cs1", method: "cash", amount: 1000 }],
      sales: [
        { cashSessionId: "cs1", totalCents: 4000, subtotalCents: 4000, discountCents: 0, loyaltyDiscountCents: 0, changeCents: 1000 },
        { cashSessionId: "cs1", totalCents: 8000, subtotalCents: 8000, discountCents: 0, loyaltyDiscountCents: 0, changeCents: 0 },
      ],
      movements: [{ id: "m1", sessionId: "cs1", type: "out", amountCents: 500, reason: "Mensajero", createdById: OWNER.id }],
    });
  }

  it("locks the session FOR UPDATE, stores expected and discrepancy, audit-logs it", async () => {
    const t = closing();
    // 100 float + 40 + 20 cash - 10 refund - 5 out = 145 expected; 140 counted.
    const out = (await t.service.close(T, "cs1", OWNER, { countedCashCents: 14_000, notes: "faltan 5" })) as CashSessionFullView;
    expect(t.locks[0]).toMatch(/FROM "cash_sessions".*FOR UPDATE/);
    expect(t.sessions[0]).toMatchObject({
      status: "closed",
      closedById: OWNER.id,
      countedCashCents: 14_000,
      expectedCashCents: 14_500,
      discrepancyCents: -500,
      closingNotes: "faltan 5",
    });
    expect(out.figures.byMethod.map((m: any) => [m.method, m.amountCents])).toEqual([
      ["cash", 6000],
      ["card", 6000],
    ]);
    expect(out.figures.cash).toMatchObject({ changeGivenCents: 1000, tenderedCents: 7000, refundsCents: 1000, movementsOutCents: 500 });
    expect(t.audit.record).toHaveBeenCalledWith(
      "pos.cash_session.closed",
      expect.objectContaining({ metadata: { sessionId: "cs1", countedCashCents: 14_000, expectedCashCents: 14_500, discrepancyCents: -500 } }),
      t.prisma,
    );
  });

  it("staff close blind: the same figures are stored, they get back only what they counted, their movements and the time", async () => {
    const t = closing();
    t.movements.push({ id: "m2", sessionId: "cs1", type: "in", amountCents: 300, reason: "Cambio", createdById: STAFF.id, createdAt: new Date() });
    // 145 + 3 in = 148 expected; 140 counted.
    const out: any = await t.service.close(T, "cs1", STAFF, { countedCashCents: 14_000, breakdown: { "5000": 2, "2000": 2 }, notes: "ok" });
    expect(t.sessions[0]).toMatchObject({ status: "closed", closedById: STAFF.id, expectedCashCents: 14_800, discrepancyCents: -800 });
    expect(out).toMatchObject({
      blind: true,
      status: "closed",
      countedCashCents: 14_000,
      countBreakdown: { "5000": 2, "2000": 2 },
      closingNotes: "ok",
      closedBy: { id: STAFF.id },
    });
    expect(out.closedAt).toBeInstanceOf(Date);
    for (const key of ["expectedCashCents", "discrepancyCents", "figures"]) expect(out).not.toHaveProperty(key);
    // Their own movement, not the owner's.
    expect(out.movements.map((m: any) => m.id)).toEqual(["m2"]);
    // Nothing in the blind view is a total: no number but the float, the count and their movements.
    expect(JSON.stringify(out)).not.toMatch(/14800|-800|6000/);
  });

  it("keeps a count by coin and note when it adds up, refuses it otherwise", async () => {
    const t = closing();
    await expect(t.service.close(T, "cs1", STAFF, { countedCashCents: 14_500, breakdown: { "5000": 2 } })).rejects.toThrow(
      BadRequestException,
    );
    expect(t.sessions[0].status).toBe("open");
    await t.service.close(T, "cs1", STAFF, { countedCashCents: 14_500, breakdown: { "5000": 2, "2000": 2, "500": 1 } });
    expect(t.sessions[0]).toMatchObject({ discrepancyCents: 0, countBreakdown: { "5000": 2, "2000": 2, "500": 1 } });
  });

  it("a session already closed is a 409; another salon's or an unknown one a 404", async () => {
    const t = closing();
    await t.service.close(T, "cs1", STAFF, { countedCashCents: 14_500 });
    const again = await t.service.close(T, "cs1", OWNER, { countedCashCents: 0 }).catch((e) => e);
    expect(again).toBeInstanceOf(ConflictException);
    expect(again.getResponse()).toMatchObject({ code: "CASH_SESSION_NOT_OPEN" });
    await expect(t.service.close("t2", "cs1", OWNER, { countedCashCents: 0 })).rejects.toThrow(NotFoundException);
  });
});

describe("money in and out of the drawer", () => {
  it("records it with the reason under a shared lock, audit-logged", async () => {
    const t = drawer({ sessions: [openSession()] });
    await t.service.addMovement(T, "cs1", STAFF, { type: "in", amountCents: 2000, reason: "  Cambio del banco " });
    expect(t.locks[0]).toMatch(/FOR SHARE/);
    expect(t.movements[0]).toMatchObject({ tenantId: T, sessionId: "cs1", type: "in", amountCents: 2000, reason: "Cambio del banco" });
    expect(t.audit.record).toHaveBeenCalledWith("pos.cash_movement.created", expect.anything(), t.prisma);
  });

  it("cannot take out more than the drawer should hold", async () => {
    const t = drawer({ sessions: [openSession()] });
    await expect(t.service.addMovement(T, "cs1", OWNER, { type: "out", amountCents: 10_001, reason: "Banco" })).rejects.toThrow(
      /debería haber 100,00/,
    );
    await t.service.addMovement(T, "cs1", OWNER, { type: "out", amountCents: 10_000, reason: "Banco" });
    expect(t.movements).toHaveLength(1);
  });

  it("staff are not refused on what the drawer should hold: the refusal would tell them", async () => {
    const t = drawer({ sessions: [openSession()] });
    await t.service.addMovement(T, "cs1", STAFF, { type: "out", amountCents: 10_001, reason: "Banco" });
    expect(t.movements[0]).toMatchObject({ type: "out", amountCents: 10_001, createdById: STAFF.id });
  });

  it("only into the session that is open", async () => {
    const t = drawer({ sessions: [openSession()] });
    await expect(t.service.addMovement(T, "cs-old", OWNER, { type: "in", amountCents: 100, reason: "x" })).rejects.toThrow(
      ConflictException,
    );
    await expect(t.service.addMovement(T, "cs1", OWNER, { type: "in", amountCents: 100, reason: "   " })).rejects.toThrow(
      /motivo/,
    );
  });
});

describe("who sees what", () => {
  it("the routes: the whole team runs the till; the history is the owner's and managers'", () => {
    const roles = (name: keyof CashSessionsController) =>
      Reflect.getMetadata(ROLES_KEY, (CashSessionsController.prototype as any)[name]);
    for (const name of ["current", "open", "addMovement", "close", "report"] as const) expect(roles(name)).toEqual(SALON_TEAM);
    expect(roles("list")).toEqual(SALON_MANAGERS);
  });

  it("the bodies are validated classes", async () => {
    expect(bodyMetatype(CashSessionsController, "open")).toBe(OpenCashSessionDto);
    expect(bodyMetatype(CashSessionsController, "close")).toBe(CloseCashSessionDto);
    expect(bodyMetatype(CashSessionsController, "addMovement")).toBe(CashMovementDto);
    await expect(bodyParser(CashSessionsController, "open")({ openingFloatCents: -1 })).rejects.toThrow();
    await expect(bodyParser(CashSessionsController, "close")({ countedCashCents: 12.5 })).rejects.toThrow();
    await expect(bodyParser(CashSessionsController, "addMovement")({ type: "sideways", amountCents: 100, reason: "x" })).rejects.toThrow();
    await expect(bodyParser(CashSessionsController, "addMovement")({ type: "out", amountCents: 0, reason: "x" })).rejects.toThrow();
  });

  it("staff see the open session and their own past ones; a manager sees any", async () => {
    const t = drawer({
      sessions: [
        openSession({ id: "cs-mine", status: "closed", openedById: STAFF.id }),
        openSession({ id: "cs-theirs", status: "closed", openedById: OTHER_STAFF.id, closedById: OTHER_STAFF.id }),
        openSession({ id: "cs-now", openedById: OTHER_STAFF.id }),
      ],
    });
    await expect(t.service.report(T, "cs-mine", STAFF)).resolves.toMatchObject({ id: "cs-mine" });
    await expect(t.service.report(T, "cs-now", STAFF)).resolves.toMatchObject({ id: "cs-now" });
    await expect(t.service.report(T, "cs-theirs", STAFF)).rejects.toThrow(ForbiddenException);
    await expect(t.service.report(T, "cs-theirs", OWNER)).resolves.toMatchObject({ id: "cs-theirs" });
    await expect(t.service.report("t2", "cs-mine", OWNER)).rejects.toThrow(NotFoundException);
  });

  it("staff get the blind view everywhere; the owner the full one, top-ups included", async () => {
    const t = drawer({
      sessions: [openSession({ openedById: OTHER_STAFF.id })],
      payments: [{ cashSessionId: "cs1", method: "cash", amount: 2500 }, { cashSessionId: "cs1", method: "card", amount: 4000 }],
      movements: [
        { id: "m-other", sessionId: "cs1", type: "in", amountCents: 1000, reason: "Cambio", createdById: OTHER_STAFF.id, createdAt: new Date() },
        { id: "m-mine", sessionId: "cs1", type: "out", amountCents: 200, reason: "Café", createdById: STAFF.id, createdAt: new Date() },
      ],
      walletTx: [
        { tenantId: T, cashSessionId: "cs1", type: "credit", method: "cash", amount: 3000 },
        { tenantId: T, cashSessionId: "cs1", type: "credit", method: "card", amount: 1500 },
        // A refund back to the wallet: no tender, no money in the drawer.
        { tenantId: T, cashSessionId: "cs1", type: "credit", method: null, amount: 900 },
        { tenantId: "t2", cashSessionId: "cs1", type: "credit", method: "cash", amount: 99_999 },
      ],
    });
    const forStaff: any = (await t.service.current(T, STAFF)).session;
    const reportForStaff: any = await t.service.report(T, "cs1", STAFF);
    for (const view of [forStaff, reportForStaff]) {
      expect(view).toMatchObject({ blind: true, id: "cs1", openingFloatCents: 10_000, countedCashCents: null });
      for (const key of ["expectedCashCents", "discrepancyCents", "figures"]) expect(view).not.toHaveProperty(key);
      expect(view.movements.map((m: any) => m.id)).toEqual(["m-mine"]);
    }
    // No figure was even worked out for them.
    expect(t.prisma.payment.findMany).not.toHaveBeenCalled();

    const full = (await t.service.report(T, "cs1", OWNER)) as CashSessionFullView;
    // 100 float + 25 cash sale + 30 cash top-up + 10 in - 2 out = 163.
    expect(full).toMatchObject({ blind: false, expectedCashCents: 16_300 });
    expect(full.figures.cash).toMatchObject({ salesCents: 2500, walletTopUpsCents: 3000, expectedCents: 16_300 });
    expect(full.figures.byMethod.map((m) => [m.method, m.count, m.amountCents, m.topUpCents])).toEqual([
      ["cash", 2, 5500, 3000],
      ["card", 2, 5500, 1500],
    ]);
    expect(full.figures.walletTopUps).toEqual({ count: 2, totalCents: 4500 });
    expect(full.movements.map((m) => m.id)).toEqual(["m-other", "m-mine"]);
  });
});

describe("the till: cash needs the drawer open", () => {
  function till(cashSessionId: string | null) {
    const sales = saleTables({ sales: [], lines: [], cashSessionId });
    const prisma: any = {
      payment: { create: jest.fn(async ({ data }: any) => ({ id: `p${Math.random()}`, ...data })) },
      service: {
        findMany: jest.fn(async ({ where }: any) =>
          where.id.in.includes("s1") ? [{ id: "s1", name: "Corte", price: 40, isActive: true }] : [],
        ),
      },
      client: { findFirst: jest.fn(async ({ where }: any) => (where.id ? { id: where.id } : null)), create: jest.fn() },
      tenant: { findUnique: jest.fn(async () => salonTenant()) },
      professional: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
      ...sales,
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    return { prisma, sales, pos: new PosService(prisma, { deductFunds: jest.fn() } as any) };
  }
  const ticket = (payments: Array<{ method: string; amount: number }>) =>
    ({ tenantId: T, actor: STAFF, items: [{ serviceId: "s1", quantity: 1 }], payments }) as any;

  it("drawer closed: cash is refused with a 409 before anything is written", async () => {
    const t = till(null);
    const err = await t.pos.processCheckout(ticket([{ method: "cash", amount: 5000 }])).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "CASH_SESSION_CLOSED" });
    expect(t.prisma.$transaction).not.toHaveBeenCalled();
    // The cash part of a mixed payment needs it too.
    await expect(
      t.pos.processCheckout(ticket([{ method: "card", amount: 2000 }, { method: "cash", amount: 2000 }])),
    ).rejects.toThrow(/La caja está cerrada/);
  });

  it("drawer closed: card and Bizum still sell, linked to no session", async () => {
    const t = till(null);
    await t.pos.processCheckout(ticket([{ method: "card", amount: 4000 }]));
    await t.pos.processCheckout(ticket([{ method: "bizum", amount: 4000 }]));
    expect(t.sales.store.sales.map((s) => s.cashSessionId)).toEqual([undefined, undefined]);
    expect(t.prisma.payment.create.mock.calls.every((c: any) => c[0].data.cashSessionId === undefined)).toBe(true);
  });

  it("drawer open: the sale and every payment of it (cash part and card part) belong to the session", async () => {
    const t = till(OPEN_CASH_SESSION);
    const out = await t.pos.processCheckout(ticket([{ method: "card", amount: 1000 }, { method: "cash", amount: 5000 }]));
    expect(out.change).toBe(2000);
    expect(t.sales.store.sales[0]).toMatchObject({ cashSessionId: OPEN_CASH_SESSION, changeCents: 2000 });
    expect(t.prisma.payment.create.mock.calls.map((c: any) => [c[0].data.method, c[0].data.amount, c[0].data.cashSessionId])).toEqual([
      ["card", 1000, OPEN_CASH_SESSION],
      ["cash", 3000, OPEN_CASH_SESSION],
    ]);
    // Held FOR SHARE inside the sale's transaction: a close waits for it.
    const sqls = t.sales.$queryRaw.mock.calls.map((c: any) => String(c[0].sql));
    expect(sqls.some((s: string) => /FOR SHARE/.test(s))).toBe(true);
  });

  it("the drawer closing between the check and the sale: the cash sale rolls back with the same 409", async () => {
    const t = till(OPEN_CASH_SESSION);
    // Open when checked, closed by the time the sale's transaction locks it.
    t.sales.$queryRaw.mockImplementationOnce(async () => [{ id: OPEN_CASH_SESSION }]).mockImplementationOnce(async () => []);
    await expect(t.pos.processCheckout(ticket([{ method: "cash", amount: 4000 }]))).rejects.toThrow(/La caja está cerrada/);
    expect(t.sales.store.sales).toHaveLength(0);
  });
});
