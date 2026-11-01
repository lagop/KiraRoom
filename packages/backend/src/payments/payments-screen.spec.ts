import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import { ArgumentMetadata, BadRequestException, ConflictException, ForbiddenException, NotFoundException, ValidationPipe } from "@nestjs/common";
import { PATH_METADATA, METHOD_METADATA } from "@nestjs/common/constants";
import { Prisma } from "@prisma/client";
import { PaymentsController } from "./payments.controller";
import { PaymentsService } from "./payments.service";
import { PaymentFiltersDto, PaymentsListQueryDto, paymentWhere } from "./payments-query";
import { WalletService } from "./services/wallet.service";
import { StripeService } from "./services/stripe.service";
import { isMaskedKey, maskSecretKey, revealSecretKey, secretKeyChange } from "./services/stripe-keys";
import { ROLES_KEY, SALON_MANAGERS } from "../auth/decorators/roles.decorator";
import { settleTenders } from "../pos/pos-tenders";
import { PosService } from "../pos/pos.service";
import { ExportsService, paymentConcept } from "../exports/exports.service";

/**
 * The Pagos screen and its API (audit 2026-11-01): what each fix promises.
 */

const T = "11111111-1111-4111-8111-111111111111";
const PAY = "22222222-2222-4222-8222-222222222222";
const APT = "33333333-3333-4333-8333-333333333333";
const CLIENT = "44444444-4444-4444-8444-444444444444";

const OWNER = { user: { id: "u-owner", tenantId: T, role: "owner" } };
const STAFF = { user: { id: "u-staff", tenantId: T, role: "staff" } };
// Built at runtime so no literal in the repo looks like a Stripe key to the secret scan.
const LIVE = "sk_" + "live_";
const TEST = "sk_" + "test_";

function controller(over: { payments?: any; wallet?: any; stripe?: any; professional?: any } = {}) {
  const professionals = { getProfessionalByUserId: jest.fn(async () => over.professional ?? null) };
  return {
    c: new PaymentsController(
      over.payments ?? ({} as any),
      {} as any,
      over.wallet ?? ({} as any),
      over.stripe ?? ({} as any),
      professionals as any,
      {} as any,
    ),
    professionals,
  };
}

/** Every route of the controller, as "VERB path". */
function routes(): string[] {
  const proto = PaymentsController.prototype as any;
  const verbs = ["GET", "POST", "PUT", "DELETE", "PATCH", "ALL", "OPTIONS", "HEAD"];
  return Object.getOwnPropertyNames(proto)
    .filter((k) => typeof proto[k] === "function" && Reflect.hasMetadata(PATH_METADATA, proto[k]))
    .map((k) => `${verbs[Reflect.getMetadata(METHOD_METADATA, proto[k])]} ${Reflect.getMetadata(PATH_METADATA, proto[k])}`);
}

describe("A1/A2/B5: routes that rewrote the till's history are gone", () => {
  it("no PATCH :id/status, no deposit / collect-balance, no confirm", () => {
    const all = routes();
    expect(all).not.toContain("PATCH :id/status");
    expect(all).not.toContain("POST appointments/:appointmentId/deposit");
    expect(all).not.toContain("POST appointments/:appointmentId/collect-balance");
    expect(all).not.toContain("POST confirm/:paymentIntentId");
    expect(all).toContain("POST :id/refund");
  });

  it("and their service methods with them", () => {
    const svc = PaymentsService.prototype as any;
    for (const m of ["updatePaymentStatus", "processDeposit", "collectBalance", "confirmPayment"]) {
      expect(svc[m]).toBeUndefined();
    }
    const stripe = StripeService.prototype as any;
    for (const m of ["createPaymentIntent", "createPaymentIntentWithDetails", "createRefund"]) {
      expect(stripe[m]).toBeUndefined();
    }
  });
});

describe("A3: Stripe settings use the injected Prisma", () => {
  it("never builds its own PrismaService", () => {
    const src = fs.readFileSync(path.join(__dirname, "payments.controller.ts"), "utf8");
    expect(src).not.toMatch(/new PrismaService/);
  });
});

describe("M1: a staff user without a professional record sees no payment", () => {
  const svc = () => ({
    getPayments: jest.fn(async () => ({ payments: [] })),
    getTodayPayments: jest.fn(async () => []),
    getPaymentById: jest.fn(async () => ({})),
    getPaymentsByClient: jest.fn(async () => []),
    getPaymentsByAppointment: jest.fn(async () => []),
  });

  it("403 in Spanish on every read, the service never asked", async () => {
    const payments = svc();
    const { c } = controller({ payments });
    await expect(c.getPayments(STAFF, {} as any)).rejects.toThrow(ForbiddenException);
    await expect(c.getTodayPayments(STAFF)).rejects.toThrow(/ficha de profesional/);
    await expect(c.getPayment(STAFF, PAY)).rejects.toThrow(ForbiddenException);
    await expect(c.getPaymentsByClient(STAFF, CLIENT)).rejects.toThrow(ForbiddenException);
    await expect(c.getPaymentsByAppointment(STAFF, APT)).rejects.toThrow(ForbiddenException);
    for (const fn of Object.values(payments)) expect(fn).not.toHaveBeenCalled();
  });

  it("a staff member with one gets only their appointments' payments", async () => {
    const prisma: any = {
      payment: { findMany: jest.fn(async () => []), findFirst: jest.fn(async () => null), count: jest.fn(async () => 0) },
    };
    const { c } = controller({ payments: new PaymentsService(prisma), professional: { id: "pro-1" } });

    await c.getPayments(STAFF, {} as any);
    expect(prisma.payment.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: T, appointment: { professionalId: "pro-1" } });

    await c.getPaymentsByClient(STAFF, CLIENT);
    expect(prisma.payment.findMany.mock.calls[1][0].where).toEqual({ tenantId: T, clientId: CLIENT, appointment: { professionalId: "pro-1" } });

    await expect(c.getPayment(STAFF, PAY)).rejects.toThrow(NotFoundException);
    expect(prisma.payment.findFirst.mock.calls[0][0].where).toEqual({ id: PAY, tenantId: T, appointment: { professionalId: "pro-1" } });

    await c.getPaymentsByAppointment(STAFF, APT);
    expect(prisma.payment.findMany.mock.calls[2][0].where).toEqual({ tenantId: T, appointmentId: APT, appointment: { professionalId: "pro-1" } });
  });

  it("owners see the whole salon", async () => {
    const prisma: any = { payment: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) } };
    const { c, professionals } = controller({ payments: new PaymentsService(prisma) });
    await c.getPayments(OWNER, {} as any);
    expect(prisma.payment.findMany.mock.calls[0][0].where).toEqual({ tenantId: T });
    expect(professionals.getProfessionalByUserId).not.toHaveBeenCalled();
  });
});

describe("M2: the summary cards", () => {
  function db() {
    const prisma: any = {
      tenant: { findUnique: jest.fn(async () => ({ timezone: "Europe/Madrid" })) },
      payment: {
        count: jest.fn(async () => 5),
        groupBy: jest.fn(async () => [
          { method: "card", _sum: { amount: 4000 }, _count: { _all: 1 } },
          { method: "cash", _sum: { amount: 6000 }, _count: { _all: 2 } },
        ]),
        aggregate: jest.fn(async (args: any) => ({
          _sum: { amount: args.where.status === "pending" ? 1500 : 1000 },
        })),
      },
      refund: {
        findMany: jest.fn(async () => [
          { amount: 500, payment: { method: "card", status: "paid" } },
          { amount: 2000, payment: { method: "cash", status: "refunded" } },
        ]),
      },
    };
    return prisma;
  }

  it("returns what the page reads: revenue net of refunds, count, pending, refunded, by method", async () => {
    const out = await new PaymentsService(db()).getSummary(T, {});
    expect(out).toEqual({
      totalRevenue: 9500,
      totalTransactions: 5,
      pendingAmount: 1500,
      refundedAmount: 3500,
      byMethod: [
        { method: "cash", amount: 6000, count: 2 },
        { method: "card", amount: 3500, count: 1 },
      ],
    });
  });

  it("follows the list's filters (method, dates in the salon's day)", async () => {
    const prisma = db();
    await new PaymentsService(prisma).getSummary(T, { method: "cash", dateFrom: "2026-11-01", dateTo: "2026-11-01" });
    const where = prisma.payment.count.mock.calls[0][0].where;
    expect(where.method).toBe("cash");
    // Madrid is UTC+1 on 1 November: the day runs 23:00Z to 23:00Z.
    expect(where.createdAt).toEqual({ gte: new Date("2026-10-31T23:00:00.000Z"), lt: new Date("2026-11-01T23:00:00.000Z") });
    expect(prisma.refund.findMany.mock.calls[0][0].where.payment).toEqual(where);
  });

  it("is for managers only", () => {
    expect(Reflect.getMetadata(ROLES_KEY, PaymentsController.prototype.getPaymentStats)).toEqual(SALON_MANAGERS);
  });
});

describe("M3: the list's query", () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false });
  const parse = (q: Record<string, string>, metatype: any = PaymentsListQueryDto) =>
    pipe.transform(q, { type: "query", metatype } as ArgumentMetadata);

  it("accepts the real statuses and methods, and numbers for page and limit", async () => {
    expect(await parse({ status: "paid", method: "cash", page: "2", limit: "50", dateFrom: "2026-11-01" })).toMatchObject({
      status: "paid",
      method: "cash",
      page: 2,
      limit: 50,
      dateFrom: "2026-11-01",
    });
    // The till sends full instants.
    expect(await parse({ dateTo: "2026-11-01T22:59:59.999Z" })).toMatchObject({ dateTo: "2026-11-01T22:59:59.999Z" });
  });

  it("answers a 400 in Spanish instead of a Prisma error or a 500", async () => {
    for (const q of [
      { status: "succeeded" },
      { status: "partially_refunded" },
      { method: "crypto" },
      { page: "abc" },
      { page: "0" },
      { limit: "101" },
      { limit: "1.5" },
      { dateFrom: "2026-13-01" },
      { dateTo: "ayer" },
      { sortBy: "password" },
      { clientId: "not-a-uuid" },
    ]) {
      await expect(parse(q)).rejects.toBeInstanceOf(BadRequestException);
    }
    await expect(parse({ status: "succeeded" })).rejects.toMatchObject({
      response: { message: [expect.stringMatching(/estado no es válido/)] },
    });
  });

  it("the summary takes the same filters", async () => {
    await expect(parse({ method: "nope" }, PaymentFiltersDto)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("filters method on the server, and refuses a range that ends before it starts", () => {
    expect(paymentWhere(T, { method: "bank_transfer" })).toEqual({ tenantId: T, method: "bank_transfer" });
    expect(() => paymentWhere(T, { dateFrom: "2026-11-02", dateTo: "2026-11-01" })).toThrow(/posterior/);
  });
});

describe("M4: POST /payments/:id/refund", () => {
  function setup(over: {
    method?: string;
    refunds?: { amount: number }[];
    appointmentId?: string | null;
    amountPaid?: number;
    invoice?: any;
    paymentCount?: number;
    stripePaymentId?: string | null;
    status?: string;
  } = {}) {
    const payment = {
      id: PAY,
      tenantId: T,
      clientId: CLIENT,
      appointmentId: over.appointmentId === undefined ? APT : over.appointmentId,
      amount: 4000,
      method: over.method ?? "cash",
      status: over.status ?? "paid",
      stripePaymentId: over.stripePaymentId ?? null,
      metadata: { posSaleId: "sale-1" },
      updatedAt: new Date(1_000),
      refunds: over.refunds ?? [],
    };
    const prisma: any = {
      payment: {
        findFirst: jest.fn(async () => payment),
        updateMany: jest.fn(async () => ({ count: over.paymentCount ?? 1 })),
      },
      refund: { create: jest.fn(async ({ data }: any) => ({ id: "ref-1", ...data })) },
      appointment: {
        findFirst: jest.fn(async () => ({
          id: APT,
          amountPaid: new Prisma.Decimal(over.amountPaid ?? 4000),
          paymentStatus: "paid",
        })),
        updateMany: jest.fn(async () => ({ count: 1 })),
      },
      invoice: { findFirst: jest.fn(async () => over.invoice ?? null) },
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    const loyalty: any = { onPaymentRefunded: jest.fn(async () => undefined), settleAppointment: jest.fn() };
    const wallet: any = { creditIn: jest.fn(async () => ({ wallet: { balance: 4000 } })) };
    return { prisma, loyalty, wallet, service: new PaymentsService(prisma, loyalty, wallet) };
  }

  it("is for owner and admin only", () => {
    expect(Reflect.getMetadata(ROLES_KEY, PaymentsController.prototype.refundPayment)).toEqual(SALON_MANAGERS);
  });

  it("a full refund: Refund row, payment refunded, appointment back to 0 and refunded, points taken back", async () => {
    const t = setup();
    const out = await t.service.refundPayment(T, PAY, { reason: "Error al cobrar" }, "u-owner");

    expect(t.prisma.payment.updateMany).toHaveBeenCalledWith({
      where: { id: PAY, tenantId: T, status: "paid", updatedAt: new Date(1_000) },
      data: expect.objectContaining({ status: "refunded" }),
    });
    expect(t.prisma.refund.create).toHaveBeenCalledWith({
      data: { paymentId: PAY, amount: 4000, reason: "Error al cobrar", status: "succeeded", adminId: "u-owner" },
    });
    expect(t.prisma.appointment.updateMany).toHaveBeenCalledWith({
      where: { id: APT, tenantId: T, amountPaid: new Prisma.Decimal(4000) },
      data: { amountPaid: 0, paymentStatus: "refunded" },
    });
    expect(t.loyalty.onPaymentRefunded).toHaveBeenCalledWith(T, expect.objectContaining({ id: PAY, status: "refunded" }));
    expect(t.wallet.creditIn).not.toHaveBeenCalled();
    expect(out).toMatchObject({ refundedAmount: 4000, refundableAmount: 0, rectificationNeeded: false, invoice: null });
  });

  it("a partial refund: payment stays paid, appointment's amountPaid goes down, points untouched", async () => {
    const t = setup();
    const out = await t.service.refundPayment(T, PAY, { amount: 1500, reason: "Descuento posterior" });
    expect(t.prisma.payment.updateMany.mock.calls[0][0].data.status).toBe("paid");
    expect(t.prisma.appointment.updateMany.mock.calls[0][0].data).toEqual({ amountPaid: 2500, paymentStatus: "paid" });
    expect(t.loyalty.onPaymentRefunded).not.toHaveBeenCalled();
    expect(out).toMatchObject({ refundedAmount: 1500, refundableAmount: 2500 });
  });

  it("refuses more than is left to refund, with what is left", async () => {
    const t = setup({ refunds: [{ amount: 3000 }] });
    await expect(t.service.refundPayment(T, PAY, { amount: 1500, reason: "x" })).rejects.toThrow(
      /Como máximo puedes devolver 10,00\s€.*ya se devolvieron 30,00\s€/,
    );
    expect(t.prisma.$transaction).not.toHaveBeenCalled();
    // The rest is still refundable, and then the payment is refunded.
    await t.service.refundPayment(T, PAY, { reason: "x" });
    expect(t.prisma.refund.create.mock.calls[0][0].data.amount).toBe(1000);
    expect(t.prisma.payment.updateMany.mock.calls[0][0].data.status).toBe("refunded");
  });

  it("refuses a payment already refunded, not paid, or taken online", async () => {
    await expect(setup({ status: "refunded" }).service.refundPayment(T, PAY, { reason: "x" })).rejects.toThrow(ConflictException);
    await expect(setup({ status: "pending" }).service.refundPayment(T, PAY, { reason: "x" })).rejects.toThrow(/pagado/);
    await expect(setup({ stripePaymentId: "pi_1" }).service.refundPayment(T, PAY, { reason: "x" })).rejects.toThrow(/Stripe/);
  });

  it("a refund racing another gets a 409 and writes nothing else", async () => {
    const t = setup({ paymentCount: 0 });
    await expect(t.service.refundPayment(T, PAY, { reason: "x" })).rejects.toThrow(ConflictException);
    expect(t.prisma.refund.create).not.toHaveBeenCalled();
    expect(t.prisma.appointment.updateMany).not.toHaveBeenCalled();
  });

  it("a wallet payment's money goes back to the wallet, in the same transaction", async () => {
    const t = setup({ method: "wallet", appointmentId: null });
    await t.service.refundPayment(T, PAY, { amount: 1000, reason: "Devolución" });
    expect(t.wallet.creditIn).toHaveBeenCalledWith(t.prisma, T, CLIENT, 1000, "Devolución: Devolución", "refund", "ref-1");
  });

  it("an issued invoice is not edited: the answer names it for a rectificativa", async () => {
    const t = setup({ invoice: { id: "inv-1", series: "A", number: "000123" } });
    const out = await t.service.refundPayment(T, PAY, { reason: "x" });
    expect(out).toMatchObject({ rectificationNeeded: true, invoice: { id: "inv-1", number: "A000123" } });
    expect(t.prisma.invoice.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: T, sourceType: "appointment", sourceId: APT }) }),
    );
  });

  it("another salon's payment is a 404", async () => {
    const t = setup();
    t.prisma.payment.findFirst.mockResolvedValueOnce(null);
    await expect(t.service.refundPayment(T, PAY, { reason: "x" })).rejects.toThrow(NotFoundException);
    expect(t.prisma.payment.findFirst.mock.calls[0][0].where).toEqual({ id: PAY, tenantId: T });
  });
});

describe("M5: the wallet never goes negative", () => {
  /** An in-memory wallet whose conditional update is atomic, like Postgres's. */
  function memoryWallet(balance: number) {
    const state = { balance };
    const tx: any = {
      clientWallet: {
        upsert: jest.fn(async () => ({ id: "w1", tenantId: T, balance: state.balance })),
        updateMany: jest.fn(async ({ where, data }: any) => {
          await new Promise((r) => setImmediate(r)); // let the other charge interleave
          if (state.balance < where.balance.gte) return { count: 0 };
          state.balance -= data.balance.decrement;
          return { count: 1 };
        }),
        findUnique: jest.fn(async () => ({ balance: state.balance })),
        findUniqueOrThrow: jest.fn(async () => ({ id: "w1", tenantId: T, balance: state.balance })),
      },
      walletTransaction: { create: jest.fn(async ({ data }: any) => data) },
    };
    const prisma: any = { $transaction: (fn: any) => fn(tx) };
    return { state, tx, wallet: new WalletService(prisma) };
  }

  it("two 8 € charges at once on 10 €: one passes, the other is refused, 2 € left", async () => {
    const { state, wallet } = memoryWallet(1000);
    const results = await Promise.allSettled([
      wallet.deductFunds(T, CLIENT, 800),
      wallet.deductFunds(T, CLIENT, 800),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(BadRequestException);
    expect(refused.reason.message).toMatch(/Saldo insuficiente/);
    expect(state.balance).toBe(200);
  });

  it("the balance after is read from the row written", async () => {
    const { wallet } = memoryWallet(1000);
    const out = await wallet.deductFunds(T, CLIENT, 300);
    expect(out.transaction).toMatchObject({ type: "debit", amount: 300, balanceAfter: 700 });
  });
});

describe("M7: the salon's Stripe secret keys", () => {
  const enc = {
    encrypt: jest.fn((v: string) => `v2.iv.tag.${Buffer.from(v).toString("base64")}`),
    decrypt: jest.fn((v: string) => Buffer.from(v.split(".")[3], "base64").toString()),
  };

  it("masks to prefix and last four", () => {
    expect(maskSecretKey(LIVE + "51Habcdefghijkl1234")).toBe(LIVE + "…1234");
    expect(maskSecretKey(null)).toBeNull();
    expect(isMaskedKey(LIVE + "…1234")).toBe(true);
  });

  it("reads old plain keys as they are and decrypts new ones", () => {
    expect(revealSecretKey(TEST + "abc123", null)).toBe(TEST + "abc123");
    expect(revealSecretKey(enc.encrypt(TEST + "abc123"), enc.decrypt)).toBe(TEST + "abc123");
    expect(revealSecretKey("garbage", () => { throw new Error("bad"); })).toBeNull();
  });

  it("a masked value sent back keeps the key; a key of the wrong mode is refused", () => {
    expect(secretKeyChange(LIVE + "…1234", "live")).toEqual({ kind: "keep" });
    expect(secretKeyChange(undefined, "live")).toEqual({ kind: "keep" });
    expect(secretKeyChange("", "live")).toEqual({ kind: "clear" });
    expect(secretKeyChange(LIVE + "new9999", "live")).toEqual({ kind: "set", plain: LIVE + "new9999" });
    expect(() => secretKeyChange(TEST + "new9999", "live")).toThrow(/sk_live_/);
    expect(() => secretKeyChange("pk_live_x", "live")).toThrow(BadRequestException);
  });

  function stripe(stored: Record<string, string | null>) {
    const prisma: any = {
      tenant: {
        findUnique: jest.fn(async () => ({ stripeMode: "live", stripeTestPublishableKey: null, stripeLivePublishableKey: "pk_live_y", ...stored })),
        update: jest.fn(async () => ({ stripeMode: "live" })),
      },
    };
    return { prisma, service: new StripeService({ get: () => undefined } as any, prisma, {} as any, enc as any) };
  }

  it("GET never sends a secret key, plain or encrypted", async () => {
    const plain = stripe({ stripeLiveSecretKey: LIVE + "SECRETSECRET1234", stripeTestSecretKey: null });
    const a = await plain.service.getTenantSettings(T);
    expect(a).toMatchObject({ stripeLiveSecretKey: LIVE + "…1234", liveSecretKeyConfigured: true, testSecretKeyConfigured: false, isConfigured: true });
    expect(JSON.stringify(a)).not.toContain("SECRETSECRET");

    const sealed = stripe({ stripeLiveSecretKey: enc.encrypt(LIVE + "SECRETSECRET5678"), stripeTestSecretKey: null });
    const b = await sealed.service.getTenantSettings(T);
    expect(b.stripeLiveSecretKey).toBe(LIVE + "…5678");
    expect(JSON.stringify(b)).not.toContain("SECRETSECRET");
  });

  it("PATCH keeps a masked key, encrypts a new one, clears an empty one", async () => {
    const { prisma, service } = stripe({ stripeLiveSecretKey: LIVE + "old1234", stripeTestSecretKey: null });
    await service.updateTenantSettings(T, {
      stripeMode: "live",
      stripeLiveSecretKey: LIVE + "…1234",
      stripeTestSecretKey: TEST + "new0000",
      stripeLivePublishableKey: "pk_live_y",
      stripeTestPublishableKey: "",
    });
    const data = prisma.tenant.update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("stripeLiveSecretKey");
    expect(data.stripeTestSecretKey).toBe(enc.encrypt(TEST + "new0000"));
    expect(data.stripeTestSecretKey).not.toContain(TEST + "");
    expect(data.stripeTestPublishableKey).toBeNull();
    expect(data.stripeLivePublishableKey).toBe("pk_live_y");
  });

  it("an encrypted key still enables the salon's Stripe", async () => {
    const { service } = stripe({ stripeLiveSecretKey: enc.encrypt(LIVE + "SECRETSECRET1234"), stripeTestSecretKey: null });
    expect((await service.getStripeForTenant(T)).isEnabled).toBe(true);
  });
});

describe("M8: a wallet belongs to one of this salon's clients", () => {
  it("another salon's client is a 404 before anything is read or written", async () => {
    const prisma: any = { client: { findFirst: jest.fn(async () => null) } };
    const wallet = new WalletService(prisma);
    const addFunds = jest.spyOn(wallet, "addFunds");
    const { c } = controller({ wallet });
    await expect(c.depositWallet(OWNER, CLIENT, { amount: 1000 } as any)).rejects.toThrow(/Clienta no encontrada/);
    expect(prisma.client.findFirst).toHaveBeenCalledWith({ where: { id: CLIENT, tenantId: T }, select: { id: true } });
    expect(addFunds).not.toHaveBeenCalled();
    await expect(c.getWallet(OWNER, CLIENT)).rejects.toThrow(NotFoundException);
    await expect(c.withdrawWallet(OWNER, CLIENT, { amount: 1000 } as any)).rejects.toThrow(NotFoundException);
  });
});

describe("B7: what the till records of what was handed over", () => {
  it("card, transfer and wallet must be exactly the total", () => {
    expect(() => settleTenders([{ method: "card", amount: 10000 }], 4000)).toThrow(/exactamente el total/);
    expect(settleTenders([{ method: "card", amount: 4000 }], 4000)).toEqual({ tenders: [{ method: "card", amount: 4000 }], change: 0 });
  });

  it("cash may be more: only the total is recorded, the rest is change", () => {
    expect(settleTenders([{ method: "cash", amount: 5000 }], 4250)).toEqual({ tenders: [{ method: "cash", amount: 4250 }], change: 750 });
    expect(settleTenders([{ method: "card", amount: 3000 }, { method: "cash", amount: 2000 }], 4000)).toEqual({
      tenders: [{ method: "card", amount: 3000 }, { method: "cash", amount: 1000 }],
      change: 1000,
    });
  });

  it("less than the total, or a bare gift card, is a 400", () => {
    expect(() => settleTenders([{ method: "cash", amount: 100 }], 4000)).toThrow(/menor que el total/);
    expect(() => settleTenders([{ method: "gift_card", amount: 4000 }], 4000)).toThrow(/Tarjetas regalo/);
  });
});

describe("B8: a till sale is read within the salon", () => {
  it("getOrder looks the payment and its client up by tenant", async () => {
    const prisma: any = {
      payment: { findFirst: jest.fn(async () => ({ id: PAY, clientId: CLIENT, amount: 100, method: "cash", status: "paid", createdAt: new Date() })) },
      client: { findFirst: jest.fn(async () => ({ firstName: "Ana", lastName: "P", email: null, phone: null })) },
    };
    const pos = new PosService(prisma, {} as any);
    await pos.getOrder(T, PAY);
    expect(prisma.payment.findFirst).toHaveBeenCalledWith({ where: { id: PAY, tenantId: T } });
    expect(prisma.client.findFirst).toHaveBeenCalledWith({ where: { id: CLIENT, tenantId: T } });

    prisma.payment.findFirst.mockResolvedValueOnce(null);
    await expect(pos.getOrder(T, PAY)).rejects.toThrow(NotFoundException);
  });
});

describe("B4: the payments CSV", () => {
  function res(): any {
    return {
      headers: {} as Record<string, string>,
      chunks: [] as string[],
      write(c: any) { this.chunks.push(String(c)); return true; },
      end() { this.ended = true; },
      setHeader(k: string, v: string) { this.headers[k] = v; },
    };
  }

  it("Spanish headers, client name, concept, euros with a comma, newest first, the page's filters", async () => {
    const prisma: any = {
      tenant: { findUnique: jest.fn(async () => ({ timezone: "Europe/Madrid" })) },
      payment: {
        findMany: jest.fn(async () => [
          {
            id: "p2",
            createdAt: new Date("2026-11-01T10:05:00Z"),
            amount: 5000,
            method: "card",
            status: "paid",
            client: { firstName: "=Ana", lastName: "López" },
            appointment: { service: { name: "Corte" } },
            refunds: [{ amount: 1250 }],
          },
          {
            id: "p1",
            createdAt: new Date("2026-10-31T09:00:00Z"),
            amount: 1999,
            method: "cash",
            status: "refunded",
            description: "POS Sale: Champú",
            metadata: { posSaleId: "s1" },
            client: null,
            appointment: null,
            refunds: [],
          },
        ]),
      },
    };
    const r = res();
    await new ExportsService(prisma).stream(T, "payments", "csv", r, { status: "paid", method: "card", dateFrom: "2026-11-01" });

    const args = prisma.payment.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([{ createdAt: "desc" }, { id: "desc" }]);
    expect(args.where).toMatchObject({ tenantId: T, status: "paid", method: "card", createdAt: { gte: new Date("2026-10-31T23:00:00Z") } });

    const body = r.chunks.join("");
    expect(body.startsWith("﻿Fecha;Clienta;Concepto;Forma de pago;Estado;Importe (€);Devuelto (€);ID del cobro")).toBe(true);
    expect(body).toContain(`01/11/2026 11:05;"'=Ana López";Corte;Tarjeta;Pagado;50,00;12,50;p2`);
    expect(body).toContain("31/10/2026 10:00;;Venta en caja: Champú;Efectivo;Devuelto;19,99;0,00;p1");
    expect(r.headers["Content-Disposition"]).toContain("pagos-");
  });

  it("names a till sale's concept", () => {
    expect(paymentConcept({ description: "POS Sale: Corte, Tinte" })).toBe("Venta en caja: Corte, Tinte");
    expect(paymentConcept({ appointment: { service: { name: "Manicura" } } })).toBe("Manicura");
  });
});
