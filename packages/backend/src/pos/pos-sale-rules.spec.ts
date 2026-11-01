import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { PosService } from "./pos.service";
import { InvoiceService } from "../invoices/invoices.service";
import { InvoiceCalculator } from "../invoices/invoice-calculator.service";
import { invoiceStore } from "../invoices/invoice-store.testing";
import { PaymentsService } from "../payments/payments.service";
import { cashDrawerRaw, saleTables, TAX_INCLUDED, TAX_ON_TOP } from "./pos-test-kit.testing";

/**
 * The till's money rules (pos-ticket.ts, appointment-charge.ts), end to end
 * through PosService with the real InvoiceService over in-memory tables:
 *
 *   - what is charged is the invoice total, whatever the salon's setting;
 *   - a sale without appointments gets ONE simplified invoice (series T),
 *     a full one over 3.000 EUR when the client has a NIF, else a 400;
 *     an appointment-only ticket gets none (the visit has its own);
 *   - a retry with the same saleId answers the first sale, writing nothing;
 *   - inactive services are refused; stock never goes below zero;
 *   - gift cards sold (own line, no tax, not invoiced) and spent (tender);
 *   - quick sale = one checkout; walk-in commissions on the sale line;
 *   - staff see only their own sales.
 */

type Row = Record<string, any>;

const OWNER = { id: "u-owner", role: "owner" };
const STAFF = { id: "u-me", role: "staff" };
const LONER = { id: "u-nopro", role: "staff" };
const SALE_ID = "0b8f2c3a-5d4e-4f6a-9b1c-2d3e4f5a6b7c";

function harness(opts: { fiscal?: Row; clients?: Row[]; stock?: number; appointments?: Row[] } = {}) {
  const fiscalSettings = { defaultSeries: "A", ...(opts.fiscal ?? TAX_INCLUDED) };
  const store = invoiceStore(fiscalSettings);
  const prisma: any = store.prisma;
  const payments: Row[] = [];
  const movements: Row[] = [];
  const discounts: Row[] = [];
  const services = [
    { id: "svc1", tenantId: "t1", name: "Corte", price: "40.00", isActive: true },
    { id: "svc-off", tenantId: "t1", name: "Mechas antiguas", price: "60.00", isActive: false },
    { id: "svc-big", tenantId: "t1", name: "Tratamiento completo", price: "3100.00", isActive: true },
  ];
  const products = new Map<string, Row>([
    ["prod1", { id: "prod1", tenantId: "t1", name: "Champú", price: "10.00", isActive: true, taxRate: null, trackInventory: true, quantity: opts.stock ?? 5 }],
  ]);
  const clients = opts.clients ?? [{ id: "c1", tenantId: "t1", firstName: "Ana", lastName: "Prueba", taxId: null }];
  const appointments = new Map<string, Row>((opts.appointments ?? []).map((a) => [a.id, a]));
  const pros = [
    { id: "p-me", tenantId: "t1", userId: "u-me", commissionRate: 30 },
    { id: "p-other", tenantId: "t1", userId: "u-other", commissionRate: 40 },
  ];
  const tables = saleTables();
  // The invoice numbering keeps its raw queries; the cash drawer is open.
  const invoiceRaw = prisma.$queryRaw;

  Object.assign(prisma, {
    tenant: {
      findUnique: jest.fn(async () => ({
        fiscalMode: "none",
        fiscalSettings,
        maxStaffDiscountPercent: 0,
        timezone: "Europe/Madrid",
        name: "Salón Prueba",
        legalName: "Salón Prueba SL",
        taxId: "B00000000",
        street: "Calle Mayor 1",
        city: "Madrid",
        postalCode: "28001",
        phone: null,
      })),
    },
    ...tables,
    $queryRaw: cashDrawerRaw(tables.store, invoiceRaw),
    service: {
      findMany: jest.fn(async ({ where }: any) =>
        services.filter((s) => s.tenantId === where.tenantId && (!where.id || where.id.in.includes(s.id))),
      ),
    },
    product: {
      findMany: jest.fn(async ({ where }: any) =>
        [...products.values()].filter((p) => p.tenantId === where.tenantId && where.id.in.includes(p.id)).map((p) => ({ ...p })),
      ),
      // As Postgres: the row only changes when the condition holds.
      updateMany: jest.fn(async ({ where, data }: any) => {
        const p = products.get(where.id);
        if (!p || p.tenantId !== where.tenantId || p.quantity < where.quantity.gte) return { count: 0 };
        p.quantity -= data.quantity.decrement;
        return { count: 1 };
      }),
      findFirst: jest.fn(async ({ where }: any) => {
        const p = products.get(where.id);
        return p && p.tenantId === where.tenantId ? { ...p } : null;
      }),
    },
    inventoryTransaction: { create: jest.fn(async ({ data }: any) => (movements.push(data), data)) },
    client: {
      findFirst: jest.fn(async ({ where }: any) => clients.find((c) => c.id === where.id && c.tenantId === where.tenantId) ?? null),
    },
    professional: {
      findFirst: jest.fn(async ({ where }: any) => pros.find((p) => p.userId === where.userId && p.tenantId === where.tenantId) ?? null),
      findMany: jest.fn(async ({ where }: any) => pros.filter((p) => p.tenantId === where.tenantId && where.id.in.includes(p.id))),
    },
    appointment: {
      findMany: jest.fn(async ({ where }: any) =>
        [...appointments.values()].filter((a) => where.id.in.includes(a.id) && a.tenantId === where.tenantId).map((a) => ({ ...a })),
      ),
      findFirst: jest.fn(async ({ where }: any) => {
        const a = appointments.get(where.id);
        return a && a.tenantId === where.tenantId ? a : null;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const a = appointments.get(where.id)!;
        const ok = Number(a.amountPaid) === Number(where.amountPaid);
        if (ok) Object.assign(a, data);
        return { count: ok ? 1 : 0 };
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(appointments.get(where.id)!, data)),
    },
    payment: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `pay${payments.length + 1}`, createdAt: new Date(), ...data };
        payments.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(payments.find((p) => p.id === where.id)!, data)),
      findMany: jest.fn(async () => []),
    },
    posDiscount: { createMany: jest.fn(async ({ data }: any) => (discounts.push(...data), { count: data.length })) },
  });
  // All or nothing, like Postgres.
  prisma.$transaction = jest.fn(async (fn: any) => {
    const before = {
      invoices: new Map(store.invoices),
      payments: payments.length,
      movements: movements.length,
      sales: tables.store.sales.length,
      lines: tables.store.lines.length,
      stock: new Map([...products].map(([k, v]) => [k, v.quantity])),
      cards: new Map([...cards].map(([k, v]) => [k, { ...v }])),
    };
    try {
      return await fn(prisma);
    } catch (err) {
      store.invoices.clear();
      before.invoices.forEach((v, k) => store.invoices.set(k, v));
      payments.length = before.payments;
      movements.length = before.movements;
      tables.store.sales.length = before.sales;
      tables.store.lines.length = before.lines;
      before.stock.forEach((q, k) => (products.get(k)!.quantity = q));
      cards.clear();
      before.cards.forEach((v, k) => cards.set(k, v));
      throw err;
    }
  });

  // Gift cards, in memory: the calls the till makes (GiftCardsService's in-tx API).
  const cards = new Map<string, Row>([["gc1", { id: "gc1", tenantId: "t1", code: "REGALO-AAAA", currentBalance: 3000 }]]);
  const giftCards: any = {
    redeemInTx: jest.fn(async (_tx: any, input: any) => {
      const card = input.giftCardId
        ? cards.get(input.giftCardId)
        : [...cards.values()].find((c) => c.code === input.code && c.tenantId === input.tenantId);
      if (!card) throw new BadRequestException("Tarjeta regalo no encontrada");
      if (card.currentBalance < input.amountCents) throw new BadRequestException("La tarjeta no tiene saldo suficiente");
      card.currentBalance -= input.amountCents;
      return { card };
    }),
    refundToCard: jest.fn(async (_tx: any, input: any) => {
      const card = cards.get(input.giftCardId)!;
      card.currentBalance += input.amountCents;
      return { card };
    }),
    sellInTx: jest.fn(async (_tx: any, input: any) => {
      const card = { id: `gc${cards.size + 1}`, tenantId: input.tenantId, code: `NUEVA-${cards.size + 1}`, currentBalance: input.amountCents };
      cards.set(card.id, card);
      return { card };
    }),
    sendCardEmail: jest.fn(async () => ({ sent: true })),
  };

  const invoices = new InvoiceService(prisma, new InvoiceCalculator(), { dispatchInvoice: jest.fn(async () => undefined) } as any);
  jest.spyOn(invoices, "afterIssue").mockImplementation(() => undefined as any);
  const wallet: any = { debitIn: jest.fn(), deductFunds: jest.fn(), addFunds: jest.fn() };
  const pos = new PosService(prisma, wallet, undefined, invoices, giftCards);
  const sell = (body: Row, actor: Row = OWNER) => pos.processCheckout({ tenantId: "t1", actor, ...body } as any);
  const issued = () => [...store.invoices.values()];
  return { prisma, store, pos, sell, issued, payments, movements, discounts, products, cards, giftCards, invoices, tables, appointments };
}

describe("gross charging: the till charges the invoice total", () => {
  it.each([
    ["prices include the tax", TAX_INCLUDED, 4000, 1000],
    ["prices are the base (tax on top)", TAX_ON_TOP, 4840, 1210],
  ])("%s: service + product, money = invoice total, IVA incluido shown", async (_label, fiscal, service, product) => {
    const t = harness({ fiscal });
    const quote = await t.pos.quote({
      tenantId: "t1",
      items: [{ serviceId: "svc1", quantity: 1 }, { productId: "prod1", quantity: 2 }],
      actor: OWNER,
    } as any);
    const total = service + 2 * product;
    expect(quote.total).toBe(total);
    expect(quote.tax).toMatchObject({ included: true, note: "IVA incluido" });
    expect(quote.tax.cents).toBe(total - Math.round(total / 1.21));

    const out = await t.sell({
      clientId: "c1",
      items: [{ serviceId: "svc1", quantity: 1 }, { productId: "prod1", quantity: 2 }],
      payments: [{ method: "card", amount: total }],
    });
    expect(out.total).toBe(total);
    const [invoice] = t.issued();
    expect(invoice.series).toBe("T");
    expect(invoice.totalCents).toBe(total);
    expect(t.payments.reduce((s, p) => s + p.amount, 0)).toBe(total);
    // Split by what they paid: Payment.type.
    expect(t.payments.map((p) => [p.type, p.amount])).toEqual([
      ["service", service],
      ["product", 2 * product],
    ]);
    expect(out.invoice).toMatchObject({ id: invoice.id, full: false });
  });

  it("with a ticket discount, tax on top: the invoice still says what was charged", async () => {
    const t = harness({ fiscal: TAX_ON_TOP });
    const out = await t.sell({
      items: [{ serviceId: "svc1", quantity: 1 }],
      discount: { type: "percentage", value: 10 },
      payments: [{ method: "cash", amount: 5000 }],
    });
    expect(out.total).toBe(4356); // 48,40 - 10 %
    expect(out.change).toBe(644);
    expect(t.issued()[0].totalCents).toBe(4356);
  });

  it("an appointment with tax on top is charged its invoice total, and gets no second invoice", async () => {
    const apt = {
      id: "a1",
      tenantId: "t1",
      clientId: "c1",
      professionalId: "p-me",
      serviceId: "svc1",
      status: "completed",
      paymentStatus: "pending",
      amountPaid: 0,
      totalAmount: 4000,
      price: 40,
      discount: {},
      service: { name: "Corte", price: 40 },
      professional: { commissionRate: 20 },
    };
    const t = harness({ fiscal: TAX_ON_TOP, appointments: [apt] });
    await expect(
      t.sell({ clientId: "c1", appointmentIds: ["a1"], items: [{ serviceId: "svc1", appointmentId: "a1", quantity: 1 }], payments: [{ method: "card", amount: 4000 }] }),
    ).rejects.toThrow(/menor que el total/);
    const out = await t.sell({
      clientId: "c1",
      appointmentIds: ["a1"],
      items: [{ serviceId: "svc1", appointmentId: "a1", quantity: 1 }],
      payments: [{ method: "card", amount: 4840 }],
    });
    expect(out.total).toBe(4840);
    expect(out.invoice).toBeNull();
    expect(t.issued()).toHaveLength(0);
    expect(t.appointments.get("a1")).toMatchObject({ paymentStatus: "paid" });
  });
});

describe("the sale's invoice", () => {
  it("is issued once per sale, inside its transaction, with the payments in its notes", async () => {
    const t = harness();
    const out = await t.sell({ items: [{ serviceId: "svc1", quantity: 1 }], payments: [{ method: "cash", amount: 4000 }] });
    expect(t.issued()).toHaveLength(1);
    expect(t.issued()[0]).toMatchObject({ series: "T", sourceType: "pos_sale", sourceId: out.saleId, recipientName: "Consumidor final" });
    expect(t.invoices.afterIssue).toHaveBeenCalledTimes(1);
    expect(t.tables.store.sales[0]).toMatchObject({ invoiceId: t.issued()[0].id });
  });

  it("gift cards are not on it, and a ticket of only a gift card has none", async () => {
    const t = harness();
    const out = await t.sell({
      items: [{ serviceId: "svc1", quantity: 1 }],
      giftCards: [{ amountCents: 5000, recipientName: "Eva", recipientEmail: "eva@example.com" }],
      payments: [{ method: "card", amount: 9000 }],
    });
    expect(t.issued()[0].totalCents).toBe(4000);
    expect(out.total).toBe(9000);
    const second = await t.sell({ giftCards: [{ amountCents: 2000 }], payments: [{ method: "cash", amount: 2000 }] });
    expect(second.invoice).toBeNull();
    expect(t.issued()).toHaveLength(1);
  });

  it("over 3.000 EUR: a full invoice when the client has a NIF", async () => {
    const t = harness({ clients: [{ id: "c1", tenantId: "t1", firstName: "Ana", lastName: "Prueba", taxId: "12345678Z" }] });
    const out = await t.sell({ clientId: "c1", items: [{ serviceId: "svc-big", quantity: 1 }], payments: [{ method: "bank_transfer", amount: 310000 }] });
    expect(out.invoice).toMatchObject({ full: true });
    expect(t.issued()[0]).toMatchObject({ series: "A", recipientTaxId: "12345678Z", totalCents: 310000 });
  });

  it("over 3.000 EUR without a NIF: refused in Spanish before anything is written", async () => {
    const t = harness();
    const err = await t
      .sell({ clientId: "c1", items: [{ serviceId: "svc-big", quantity: 1 }], payments: [{ method: "card", amount: 310000 }] })
      .catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).toMatch(/pasa de 3\.000 €.*NIF/);
    expect(t.payments).toHaveLength(0);
    expect(t.tables.store.sales).toHaveLength(0);
  });
});

describe("idempotency: the client's saleId", () => {
  const body = { saleId: SALE_ID, items: [{ serviceId: "svc1", quantity: 1 }], payments: [{ method: "cash", amount: 4000 }] };

  it("a retry answers the first sale and writes nothing", async () => {
    const t = harness();
    const first = await t.sell(body);
    const again = await t.sell(body);
    expect(again).toMatchObject({ saleId: first.saleId, total: 4000, replayed: true });
    expect(t.payments).toHaveLength(1);
    expect(t.issued()).toHaveLength(1);
    expect(t.tables.store.sales).toHaveLength(1);
  });

  it("two at once: the second fails the unique key, rolls back and answers the first", async () => {
    const t = harness();
    const first = await t.sell(body);
    // As if the second had checked before the first committed.
    t.tables.posSale.findUnique.mockResolvedValueOnce(null);
    const second = await t.sell(body);
    expect(second.saleId).toBe(first.saleId);
    expect(t.payments).toHaveLength(1);
    expect(t.issued()).toHaveLength(1);
  });
});

describe("what the till refuses", () => {
  it("an inactive service, in Spanish", async () => {
    const t = harness();
    await expect(t.sell({ items: [{ serviceId: "svc-off", quantity: 1 }], payments: [{ method: "cash", amount: 6000 }] })).rejects.toThrow(
      'El servicio "Mechas antiguas" está desactivado',
    );
  });

  it("more units than in stock, and nothing is written", async () => {
    const t = harness({ stock: 1 });
    const err = await t
      .sell({ items: [{ productId: "prod1", quantity: 2 }], payments: [{ method: "cash", amount: 2000 }] })
      .catch((e) => e);
    expect(err.message).toBe("Sin stock suficiente de Champú: quedan 1.");
    expect(t.products.get("prod1")!.quantity).toBe(1);
    expect(t.payments).toHaveLength(0);
    expect(t.issued()).toHaveLength(0);
  });

  it("a product sold takes its stock and logs the movement", async () => {
    const t = harness({ stock: 5 });
    await t.sell({ items: [{ productId: "prod1", quantity: 2 }], payments: [{ method: "cash", amount: 2000 }] });
    expect(t.products.get("prod1")!.quantity).toBe(3);
    expect(t.movements).toEqual([expect.objectContaining({ type: "sale", quantity: -2, previousQty: 5, newQty: 3, reason: "Venta en caja" })]);
  });
});

describe("gift cards at the till", () => {
  it("sold: its own untaxed line, the card issued in the sale and emailed after", async () => {
    const t = harness();
    const out = await t.sell({
      clientId: "c1",
      giftCards: [{ amountCents: 5000, recipientName: "Eva", recipientEmail: "eva@example.com", message: "Feliz cumple" }],
      payments: [{ method: "bizum", amount: 5000 }],
    });
    expect(t.giftCards.sellInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ amountCents: 5000, recipientEmail: "eva@example.com", purchasedById: "c1" }));
    expect(t.giftCards.sendCardEmail).toHaveBeenCalledWith("t1", out.giftCards[0].id);
    expect(t.payments).toEqual([expect.objectContaining({ type: "gift_card", method: "bizum", amount: 5000 })]);
    expect(t.payments[0].metadata.soldGiftCardIds).toEqual([out.giftCards[0].id]);
    expect(t.tables.store.lines).toEqual([expect.objectContaining({ kind: "gift_card", taxCents: 0, taxRate: 0, totalCents: 5000 })]);
    // The stored answer (a retry's) keeps no recipient details.
    expect(t.tables.store.sales[0].result.giftCards[0]).not.toHaveProperty("recipientEmail");
  });

  it("as a tender: the code's balance is taken in the sale; the rest in cash", async () => {
    const t = harness();
    await t.sell({
      items: [{ serviceId: "svc1", quantity: 1 }],
      payments: [
        { method: "gift_card", amount: 3000, giftCardCode: "REGALO-AAAA" },
        { method: "cash", amount: 1000 },
      ],
    });
    expect(t.cards.get("gc1")!.currentBalance).toBe(0);
    expect(t.payments.map((p) => [p.method, p.amount])).toEqual([
      ["gift_card", 3000],
      ["cash", 1000],
    ]);
    expect(t.payments[0].metadata.giftCardId).toBe("gc1");
  });

  it("not enough on the card: the whole sale rolls back", async () => {
    const t = harness();
    await expect(
      t.sell({ items: [{ serviceId: "svc1", quantity: 1 }], payments: [{ method: "gift_card", amount: 4000, giftCardCode: "REGALO-AAAA" }] }),
    ).rejects.toThrow(/saldo suficiente/);
    expect(t.payments).toHaveLength(0);
    expect(t.cards.get("gc1")!.currentBalance).toBe(3000);
    expect(t.issued()).toHaveLength(0);
  });

  it("a gift card is not paid with another gift card", async () => {
    const t = harness();
    await expect(
      t.sell({ giftCards: [{ amountCents: 2000 }], payments: [{ method: "gift_card", amount: 2000, giftCardCode: "REGALO-AAAA" }] }),
    ).rejects.toThrow(/no se puede pagar con otra tarjeta regalo/);
  });

  describe("refunds", () => {
    function refunds(payment: Row, card: Row = { currentBalance: 5000 }) {
      const prisma: any = {
        payment: {
          findFirst: jest.fn(async () => ({ refunds: [], status: "paid", updatedAt: new Date(0), tenantId: "t1", ...payment })),
          updateMany: jest.fn(async () => ({ count: 1 })),
        },
        refund: { create: jest.fn(async ({ data }: any) => ({ id: "r1", ...data })) },
        giftCard: { findFirst: jest.fn(async () => card) },
        invoice: { findFirst: jest.fn(async () => null) },
        $queryRaw: cashDrawerRaw({}),
      };
      prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
      const giftCards: any = { refundToCard: jest.fn(), redeemInTx: jest.fn() };
      return { svc: new PaymentsService(prisma, undefined, undefined, giftCards), giftCards };
    }

    it("of a payment made with a gift card: back to the card", async () => {
      const { svc, giftCards } = refunds({ id: "pay1", amount: 3000, method: "gift_card", type: "service", metadata: { giftCardId: "gc1" } });
      await svc.refundPayment("t1", "pay1", { reason: "No le gustó" });
      expect(giftCards.refundToCard).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ giftCardId: "gc1", amountCents: 3000 }));
    });

    it("of a gift card sale: taken off the card; refused once it was spent", async () => {
      const sold = { id: "pay2", amount: 5000, method: "cash", type: "gift_card", metadata: { soldGiftCardIds: ["gc9"] } };
      const ok = refunds(sold);
      await ok.svc.refundPayment("t1", "pay2", { reason: "Se equivocó" });
      expect(ok.giftCards.redeemInTx).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ giftCardId: "gc9", amountCents: 5000 }));

      const spent = refunds(sold, { currentBalance: 1000 });
      await expect(spent.svc.refundPayment("t1", "pay2", { reason: "Se equivocó" })).rejects.toThrow(/ya se ha usado/);
    });
  });
});

describe("quick sale", () => {
  it("is one checkout: priced in money, invoiced, idempotent", async () => {
    const t = harness({ fiscal: TAX_ON_TOP });
    const out = await t.pos.quickSale("t1", "svc1", "bizum", undefined, { saleId: SALE_ID, actor: OWNER });
    expect(out).toMatchObject({ amount: 4840, paymentMethod: "bizum", kind: "quick_sale" });
    expect(t.payments[0]).toMatchObject({ method: "bizum", amount: 4840, description: "Venta rápida: Corte" });
    expect(t.issued()[0].totalCents).toBe(4840);
    const again = await t.pos.quickSale("t1", "svc1", "bizum", undefined, { saleId: SALE_ID, actor: OWNER });
    expect(again.amount).toBe(4840);
    expect(t.payments).toHaveLength(1);
  });

  it("refuses an inactive service", async () => {
    const t = harness();
    await expect(t.pos.quickSale("t1", "svc-off", "cash")).rejects.toThrow(/desactivado/);
  });
});

describe("commissions of services sold without an appointment", () => {
  it("default: the team member at the till; on the catalogue basis (without the tax on top)", async () => {
    const t = harness({ fiscal: TAX_ON_TOP });
    await t.sell({ items: [{ serviceId: "svc1", quantity: 1 }], payments: [{ method: "cash", amount: 4840 }] }, STAFF);
    expect(t.tables.store.lines[0]).toMatchObject({
      kind: "service",
      professionalId: "p-me",
      commissionBaseCents: 4000,
      commissionRate: 30,
      commissionAmount: 1200,
    });
    expect(t.payments[0]).toMatchObject({ recordedById: "u-me", description: "Venta en caja: Corte" });
  });

  it("the owner may name who did it; staff only themselves", async () => {
    const t = harness();
    await t.sell({ items: [{ serviceId: "svc1", quantity: 1, professionalId: "p-other" }], payments: [{ method: "cash", amount: 4000 }] });
    expect(t.tables.store.lines[0]).toMatchObject({ professionalId: "p-other", commissionRate: 40, commissionAmount: 1600 });
    await expect(
      t.sell({ items: [{ serviceId: "svc1", quantity: 1, professionalId: "p-other" }], payments: [{ method: "cash", amount: 4000 }] }, STAFF),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe("staff see only their own sales", () => {
  function day() {
    const t = harness();
    const at = new Date("2026-11-01T09:30:00Z"); // 10:30 in Madrid
    const rows = [
      { id: "x1", amount: 4000, method: "cash", status: "paid", createdAt: at, recordedById: "u-me", appointmentId: null, metadata: {} },
      { id: "x2", amount: 9000, method: "card", status: "paid", createdAt: at, recordedById: "u-other", appointmentId: null, metadata: {} },
    ];
    t.prisma.payment.findMany = jest.fn(async ({ where }: any) => {
      const or = where.AND?.[0]?.OR as Row[] | undefined;
      return rows.filter((r) => !or || or.some((c) => c.recordedById === r.recordedById));
    });
    return t;
  }

  it("dashboard: staff get their figures and ownSalesOnly; the owner the salon's", async () => {
    const t = day();
    const mine = await t.pos.getDashboard("t1", "2026-11-01", STAFF);
    expect(mine).toMatchObject({ totalSales: 4000, ownSalesOnly: true });
    const where = t.prisma.payment.findMany.mock.calls[0][0].where;
    expect(where.AND[0]).toEqual({ OR: [{ recordedById: "u-me" }, { appointment: { professionalId: "p-me" } }] });
    const all = await t.pos.getDashboard("t1", "2026-11-01", OWNER);
    expect(all).toMatchObject({ totalSales: 13000, ownSalesOnly: false });
  });

  it("a staff user without a professional: only what they recorded (fails closed)", async () => {
    const t = day();
    await t.pos.getDailyReport("t1", "2026-11-01", LONER);
    expect(t.prisma.payment.findMany.mock.calls[0][0].where.AND[0]).toEqual({ OR: [{ recordedById: "u-nopro" }] });
  });

  it("daily report: by the salon's hour, staff scoped", async () => {
    const t = day();
    const report = await t.pos.getDailyReport("t1", "2026-11-01", STAFF);
    expect(report.summary.totalSales).toBe(4000);
    expect(report.hourlySales[10]).toEqual({ hour: 10, count: 1, amount: 4000 });
    expect(report.hourlySales[9].count).toBe(0);
    expect(report.payments[0].client).toBe("Clienta sin ficha");
  });

  it("partial refunds come off the day's sales and count as refunded, like whole ones", async () => {
    const t = harness();
    const at = new Date("2026-11-01T09:30:00Z");
    t.prisma.payment.findMany = jest.fn(async () => [
      // 40,00 paid, 15,00 given back of it (stays paid).
      { id: "y1", amount: 4000, method: "cash", status: "paid", createdAt: at, appointmentId: null, metadata: {}, refunds: [{ amount: 1500 }] },
      // Given back whole, with its refund row.
      { id: "y2", amount: 2000, method: "card", status: "refunded", createdAt: at, appointmentId: null, metadata: {}, refunds: [{ amount: 2000 }] },
      // Given back whole before refunds were recorded one by one.
      { id: "y3", amount: 1000, method: "card", status: "refunded", createdAt: at, appointmentId: null, metadata: {} },
      { id: "y4", amount: 3000, method: "card", status: "paid", createdAt: at, appointmentId: null, metadata: {}, refunds: [] },
    ]);
    const report = await t.pos.getDailyReport("t1", "2026-11-01", OWNER);
    expect(report.summary).toMatchObject({ totalSales: 5500, totalTransactions: 2, refundedAmount: 4500, refundedCount: 3 });
    expect(report.hourlySales[10]).toEqual({ hour: 10, count: 2, amount: 5500 });
    expect(report.payments.find((p: any) => p.id === "y1")).toMatchObject({ amount: 2500, refundedAmount: 1500 });
    // The query reads the refunds with the payments.
    expect(t.prisma.payment.findMany.mock.calls[0][0].include.refunds).toEqual({ where: { status: "succeeded" }, select: { amount: true } });

    const dash = await t.pos.getDashboard("t1", "2026-11-01", OWNER);
    expect(dash).toMatchObject({ totalSales: 5500, refundedAmount: 4500 });
    expect(dash.paymentBreakdown).toEqual(
      expect.arrayContaining([
        { method: "cash", amount: 2500, count: 1 },
        { method: "card", amount: 3000, count: 1 },
      ]),
    );
  });

  it("receipt: staff only of the sales they recorded (403 in Spanish)", async () => {
    const t = harness();
    const out = await t.sell({ items: [{ serviceId: "svc1", quantity: 1 }], payments: [{ method: "cash", amount: 5000 }] }, OWNER);
    t.prisma.invoice.findFirst = jest.fn(async () => ({ ...t.issued()[0] }));
    const receipt = await t.pos.getReceipt("t1", out.saleId, OWNER);
    expect(receipt).toMatchObject({ salon: { taxId: "B00000000" }, totalCents: 4000, tenderedCents: 5000, changeCents: 1000, taxNote: "IVA incluido" });
    expect(receipt.invoice.number).toMatch(/^T/);
    await expect(t.pos.getReceipt("t1", out.saleId, STAFF)).rejects.toThrow("Solo puedes ver los tickets");
  });
});
