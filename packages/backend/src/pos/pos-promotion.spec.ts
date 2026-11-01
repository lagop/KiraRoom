import { BadRequestException, ConflictException } from "@nestjs/common";
import { PosService } from "./pos.service";
import { saleTables, salonTenant, TAX_ON_TOP } from "./pos-test-kit.testing";
import { InvoiceCalculator } from "../invoices/invoice-calculator.service";
import {
  claimPromotionIn,
  promotionProblem,
  promotionWindow,
  releaseIfSaleRefundedIn,
  type TillPromotion,
} from "../promotions/promotion-at-till";

/**
 * Promotion codes at the till (promotions/promotion-at-till.ts), end to end
 * through PosService: validity in the salon's clock, the limits, the
 * minimum order, the services it applies to, the order with the manual
 * discounts and the loyalty reward, the PosDiscount record, the invoice
 * lines ("Descuento promoción CODE") and the release on a full refund. The
 * concurrent last use is in pos-promotion.l2.spec.ts, on a real database.
 */

type Row = Record<string, any>;

const DAY = (iso: string) => new Date(`${iso}T00:00:00.000Z`);

function promo(over: Partial<TillPromotion> = {}): TillPromotion {
  return {
    id: "promo-1",
    code: "OTONO10",
    name: "Otoño",
    type: "PERCENTAGE",
    value: 10,
    minOrderValue: 0,
    maxUses: null,
    maxUsesPerClient: null,
    usedCount: 0,
    startDate: DAY("2026-01-01"),
    endDate: null,
    isActive: true,
    archivedAt: null,
    applicableServiceIds: [],
    applicableProductIds: [],
    ...over,
  };
}

/** Euros, as Service.price and Product.price are stored. */
const CATALOGUE = {
  services: [
    { id: "svc1", name: "Corte", price: 40, isActive: true },
    { id: "svc2", name: "Tinte", price: 25, isActive: true },
    { id: "svc3", name: "Peinado", price: 19.99, isActive: true },
  ],
  // A book at 4 % VAT next to the salon's 21 %: mixed rates on one ticket.
  products: [
    { id: "prod1", name: "Champú", price: 12.5, isActive: true, trackInventory: false, taxRate: null },
    { id: "book", name: "Libro de peinados", price: 10.4, isActive: true, trackInventory: false, taxRate: 4 },
  ],
};

function till(opts: { promotions?: TillPromotion[]; usages?: Row[]; fiscal?: Row; maxStaff?: number; loyalty?: Row; appointments?: Row[] } = {}) {
  const promotions = (opts.promotions ?? [promo()]).map((p) => ({ tenantId: "t1", ...p }));
  const usages: Row[] = opts.usages ?? [];
  const discounts: Row[] = [];
  const payments: Row[] = [];
  const invoiceInputs: Row[] = [];
  const sales = saleTables();
  const prisma: any = {
    ...sales,
    tenant: { findUnique: jest.fn(async () => salonTenant({ maxStaffDiscountPercent: opts.maxStaff ?? 0, ...(opts.fiscal ? { fiscalSettings: opts.fiscal } : {}) })) },
    service: {
      findMany: jest.fn(async ({ where }: any) => CATALOGUE.services.filter((s) => where.id.in.includes(s.id))),
    },
    product: {
      findMany: jest.fn(async ({ where }: any) => CATALOGUE.products.filter((p) => where.id.in.includes(p.id))),
    },
    professional: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    client: { findFirst: jest.fn(async ({ where }: any) => (where.id ? { id: where.id, taxId: null } : null)), create: jest.fn() },
    appointment: {
      findMany: jest.fn(async ({ where }: any) => (opts.appointments ?? []).filter((a) => where.id.in.includes(a.id)).map((a) => ({ ...a }))),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    invoice: { findMany: jest.fn(async () => []) },
    promotion: {
      findFirst: jest.fn(async ({ where }: any) =>
        promotions.find((p) => p.tenantId === where.tenantId && (where.code ? p.code === where.code : p.id === where.id)) ?? null,
      ),
      // The conditional update of claimPromotionIn, as Postgres does it.
      updateMany: jest.fn(async ({ where, data }: any) => {
        const p = promotions.find((x) => x.id === where.id && x.tenantId === where.tenantId);
        if (!p || p.isActive !== where.isActive || (p.archivedAt ?? null) !== where.archivedAt) return { count: 0 };
        if (where.maxUses === null && p.maxUses !== null) return { count: 0 };
        if (where.maxUses != null && (p.maxUses !== where.maxUses || !(p.usedCount < where.usedCount.lt))) return { count: 0 };
        if (where.usedCount?.gt !== undefined && !(p.usedCount > where.usedCount.gt)) return { count: 0 };
        if (data.usedCount.increment) p.usedCount += data.usedCount.increment;
        if (data.usedCount.decrement) p.usedCount -= data.usedCount.decrement;
        return { count: 1 };
      }),
    },
    promotionUsage: {
      count: jest.fn(async ({ where }: any) =>
        usages.filter((u) => u.promotionId === where.promotionId && u.clientId === where.clientId && !u.releasedAt).length,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `use${usages.length + 1}`, releasedAt: null, ...data };
        usages.push(row);
        return { id: row.id };
      }),
      findMany: jest.fn(async ({ where }: any) => usages.filter((u) => u.saleId === where.saleId && !u.releasedAt)),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const u = usages.find((x) => x.id === where.id && !x.releasedAt);
        if (!u) return { count: 0 };
        Object.assign(u, data);
        return { count: 1 };
      }),
    },
    payment: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `pay${payments.length + 1}`, ...data };
        payments.push(row);
        return row;
      }),
      update: jest.fn(async () => ({})),
      count: jest.fn(async () => 0),
    },
    posDiscount: {
      createMany: jest.fn(async ({ data }: any) => {
        discounts.push(...data);
        return { count: data.length };
      }),
    },
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const loyalty: any = {
    previewSaleDiscount: jest.fn(async () => ({ discountCents: 500, pointsSpent: 50, rewardName: "5 €" })),
    redeemAtSale: jest.fn(async () => ({ discountCents: 500, pointsSpent: 50, rewardName: "5 €", redemptionId: "r1" })),
    cancelSaleRedemption: jest.fn(async () => undefined),
    earnForSale: jest.fn(async () => 0),
    settleAppointment: jest.fn(async () => ({ awarded: 0 })),
    ...opts.loyalty,
  };
  const invoices: any = {
    issueSimplifiedInvoiceForSale: jest.fn(async (_tx: any, input: any) => {
      invoiceInputs.push(input);
      return { id: "inv-1", series: "T", number: "000001", created: false };
    }),
    afterIssue: jest.fn(),
  };
  const giftCards: any = {
    redeemInTx: jest.fn(async () => ({ card: { id: "gc1" } })),
  };
  const service = new PosService(prisma, { debitIn: jest.fn() } as any, loyalty, invoices, giftCards);
  return { service, prisma, loyalty, promotions, usages, discounts, payments, invoiceInputs, sales: sales.store };
}

const OWNER = { id: "u-owner", role: "owner" };
const STAFF = { id: "u-staff", role: "staff" };

// ------------------------------------------------------------------ validity

describe("promotion validity: whole days in the salon's clock", () => {
  // 2 to 30 November, as the panel stores them (UTC midnight of each day).
  const p = promo({ startDate: DAY("2026-11-02"), endDate: DAY("2026-11-30") });
  const at = (iso: string, tz: string) => promotionProblem(p, new Date(iso), tz);

  it("Madrid (UTC+1 in November): from 00:00 of the first day to 23:59:59 of the last", () => {
    const tz = "Europe/Madrid";
    expect(at("2026-11-01T22:59:59.999Z", tz)).toBe("La promoción todavía no ha empezado.");
    expect(at("2026-11-01T23:00:00.000Z", tz)).toBeNull();
    // The last day counts whole: it used to end at its UTC midnight (01:00 in Madrid).
    expect(at("2026-11-30T12:00:00.000Z", tz)).toBeNull();
    expect(at("2026-11-30T22:59:59.999Z", tz)).toBeNull();
    expect(at("2026-11-30T23:00:00.000Z", tz)).toBe("La promoción ha terminado.");
  });

  it("Canarias (UTC+0 in November): an hour later than Madrid, both ends", () => {
    const tz = "Atlantic/Canary";
    expect(at("2026-11-01T23:30:00.000Z", tz)).toBe("La promoción todavía no ha empezado.");
    expect(at("2026-11-02T00:00:00.000Z", tz)).toBeNull();
    expect(at("2026-11-30T23:59:59.999Z", tz)).toBeNull();
    expect(at("2026-12-01T00:00:00.000Z", tz)).toBe("La promoción ha terminado.");
  });

  it("in summer time too (Madrid UTC+2, Canarias UTC+1)", () => {
    const summer = promo({ startDate: DAY("2026-07-01"), endDate: DAY("2026-07-31") });
    expect(promotionWindow(summer, "Europe/Madrid")).toEqual({
      from: new Date("2026-06-30T22:00:00.000Z"),
      until: new Date("2026-07-31T22:00:00.000Z"),
    });
    expect(promotionWindow(summer, "Atlantic/Canary")).toEqual({
      from: new Date("2026-06-30T23:00:00.000Z"),
      until: new Date("2026-07-31T23:00:00.000Z"),
    });
  });

  it("a one-day promotion is that whole day", () => {
    const oneDay = promo({ startDate: DAY("2026-11-15"), endDate: DAY("2026-11-15") });
    expect(promotionProblem(oneDay, new Date("2026-11-14T23:00:00.000Z"), "Europe/Madrid")).toBeNull();
    expect(promotionProblem(oneDay, new Date("2026-11-15T22:59:00.000Z"), "Europe/Madrid")).toBeNull();
    expect(promotionProblem(oneDay, new Date("2026-11-15T23:00:00.000Z"), "Europe/Madrid")).toBe("La promoción ha terminado.");
  });

  it("refuses an inactive, archived, used-up or buy-X-get-Y promotion", () => {
    const now = new Date("2026-11-10T10:00:00Z");
    expect(promotionProblem(promo({ isActive: false }), now, "Europe/Madrid")).toBe("La promoción ya no está activa.");
    expect(promotionProblem(promo({ archivedAt: now }), now, "Europe/Madrid")).toBe("La promoción ya no está activa.");
    expect(promotionProblem(promo({ maxUses: 3, usedCount: 3 }), now, "Europe/Madrid")).toMatch(/máximo de usos/);
    expect(promotionProblem(promo({ type: "BUY_X_GET_Y" }), now, "Europe/Madrid")).toMatch(/no se puede aplicar en caja/);
  });

  it("the till refuses a code out of its days, saying why", async () => {
    const t = till({ promotions: [promo({ startDate: DAY("2099-01-01") })] });
    await expect(
      t.service.quote({ tenantId: "t1", items: [{ serviceId: "svc1", quantity: 1 }], promotionCode: "otono10" } as any),
    ).rejects.toThrow("La promoción todavía no ha empezado.");
  });

  it("refuses a code that is not the salon's", async () => {
    const t = till();
    await expect(
      t.service.quote({ tenantId: "t1", items: [{ serviceId: "svc1", quantity: 1 }], promotionCode: "NOEXISTE" } as any),
    ).rejects.toThrow(/NOEXISTE no es de ninguna promoción/);
    expect(t.prisma.promotion.findFirst.mock.calls[0][0].where).toEqual({ tenantId: "t1", code: "NOEXISTE" });
  });
});

// ------------------------------------------------------------------ on the ticket

describe("a promotion code on the ticket", () => {
  it("comes off after the manual discounts, outside the staff's limit, and is recorded as type promotion", async () => {
    const t = till({ maxStaff: 0 });
    // Staff at a salon whose staff may not discount: the code still applies.
    const out = await t.service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      items: [{ serviceId: "svc1", quantity: 1 }],
      promotionCode: " otono10 ",
      payments: [{ method: "card", amount: 3600 }],
      actor: STAFF,
    } as any);
    expect(out.total).toBe(3600);
    expect(out.promotion).toEqual({ id: "promo-1", code: "OTONO10", name: "Otoño", discount: 400 });
    expect(out.discount).toEqual({ lines: 0, order: 0, total: 0 });
    expect(t.discounts).toEqual([
      expect.objectContaining({
        saleId: out.saleId,
        scope: "order",
        type: "promotion",
        description: "Promoción OTONO10",
        value: 10,
        baseCents: 4000,
        amountCents: 400,
        promotionId: "promo-1",
        promotionCode: "OTONO10",
        appliedById: "u-staff",
      }),
    ]);
    // The use, with the sale and the client, and the counter.
    expect(t.usages).toEqual([
      expect.objectContaining({ promotionId: "promo-1", clientId: "c1", saleId: out.saleId, appointmentId: null, discountAmount: 4 }),
    ]);
    expect(t.promotions[0].usedCount).toBe(1);
    expect(t.sales.sales[0]).toMatchObject({
      discountCents: 400,
      promotionDiscountCents: 400,
      promotionId: "promo-1",
      promotionCode: "OTONO10",
      totalCents: 3600,
    });
    expect(t.payments[0].metadata).toMatchObject({ promotionCode: "OTONO10", promotionDiscountCents: 400 });
  });

  it("is taken on what the manual discounts left (the ticket's 10 EUR first, then 10 %)", async () => {
    const t = till();
    const q: any = await t.service.quote({
      tenantId: "t1",
      items: [{ serviceId: "svc1", quantity: 1 }],
      discount: { type: "fixed", value: 1000 },
      promotionCode: "OTONO10",
      actor: OWNER,
    } as any);
    // 40 - 10 = 30; 10 % of 30 = 3.
    expect(q.discount.total).toBe(1000);
    expect(q.promotion.discount).toBe(300);
    expect(q.total).toBe(2700);
    expect(q.lines[0]).toMatchObject({ discountCents: 1300, promotionDiscountCents: 300, netCents: 2700 });
  });

  it("a quote writes nothing", async () => {
    const t = till();
    await t.service.quote({ tenantId: "t1", items: [{ serviceId: "svc1", quantity: 1 }], promotionCode: "OTONO10" } as any);
    expect(t.usages).toEqual([]);
    expect(t.promotions[0].usedCount).toBe(0);
    expect(t.prisma.promotion.updateMany).not.toHaveBeenCalled();
  });
});

describe("minimum order", () => {
  const withMin = () => till({ promotions: [promo({ minOrderValue: 50 })] });

  it("refuses a ticket under it (after the manual discounts), saying both amounts", async () => {
    const t = withMin();
    await expect(
      t.service.quote({
        tenantId: "t1",
        items: [{ serviceId: "svc1", quantity: 1 }, { productId: "prod1", quantity: 1 }],
        discount: { type: "fixed", value: 300 },
        promotionCode: "OTONO10",
        actor: OWNER,
      } as any),
    ).rejects.toThrow("El importe mínimo para usar la promoción es 50,00 € y el ticket suma 49,50 €.");
  });

  it("accepts a ticket that reaches it exactly", async () => {
    const t = withMin();
    const q: any = await t.service.quote({
      tenantId: "t1",
      items: [{ serviceId: "svc1", quantity: 1 }, { productId: "prod1", quantity: 1 }],
      discount: { type: "fixed", value: 250 },
      promotionCode: "OTONO10",
      actor: OWNER,
    } as any);
    expect(q.promotion.discount).toBe(500);
    expect(q.total).toBe(4500);
  });

  it("does not count gift cards sold on the ticket", async () => {
    const t = withMin();
    await expect(
      t.service.quote({
        tenantId: "t1",
        items: [{ serviceId: "svc1", quantity: 1 }],
        giftCards: [{ amountCents: 5000 }],
        promotionCode: "OTONO10",
      } as any),
    ).rejects.toThrow(/importe mínimo/);
  });
});

describe("a promotion limited to some services", () => {
  const onlyCut = () => till({ promotions: [promo({ value: 50, applicableServiceIds: ["svc1"] })] });

  it("comes off those lines only", async () => {
    const t = onlyCut();
    const q: any = await t.service.quote({
      tenantId: "t1",
      items: [{ serviceId: "svc1", quantity: 1 }, { serviceId: "svc2", quantity: 1 }, { productId: "prod1", quantity: 1 }],
      promotionCode: "OTONO10",
    } as any);
    expect(q.promotion.discount).toBe(2000);
    expect(q.lines.map((l: any) => l.promotionDiscountCents ?? 0)).toEqual([2000, 0, 0]);
    expect(q.total).toBe(2000 + 2500 + 1250);
  });

  it("refuses a ticket with none of them", async () => {
    const t = onlyCut();
    await expect(
      t.service.quote({ tenantId: "t1", items: [{ serviceId: "svc2", quantity: 1 }], promotionCode: "OTONO10" } as any),
    ).rejects.toThrow("La promoción solo vale para algunos servicios y no hay ninguno de ellos en este ticket.");
  });

  it("applies to an appointment of that service, on its visit's discount record", async () => {
    const appointment = {
      id: "a1",
      tenantId: "t1",
      clientId: "c1",
      professionalId: "p1",
      serviceId: "svc1",
      status: "completed",
      paymentStatus: "pending",
      amountPaid: 0,
      totalAmount: 4000,
      price: 40,
      discount: {},
      service: { name: "Corte", price: 40 },
    };
    const t = onlyCut();
    t.prisma.appointment.findMany = jest.fn(async () => [{ ...appointment }]);
    const out: any = await t.service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      appointmentIds: ["a1"],
      promotionCode: "OTONO10",
      payments: [{ method: "card", amount: 2000 }],
      actor: OWNER,
    } as any);
    expect(out.total).toBe(2000);
    expect(t.usages[0]).toMatchObject({ appointmentId: "a1", saleId: out.saleId });
    // The visit keeps the promotion's part of its till discount, for its invoice.
    const update = t.prisma.appointment.updateMany.mock.calls.find((c: any) => c[0].data.discount)?.[0].data;
    expect(update.discount.pos).toMatchObject({
      amountCents: 2000,
      promotion: { promotionId: "promo-1", code: "OTONO10", moneyCents: 2000, catalogueCents: 2000 },
    });
  });
});

// ------------------------------------------------------------------ limits

describe("the per-client limit", () => {
  const perClient = (usages: Row[] = []) => till({ promotions: [promo({ maxUsesPerClient: 1 })], usages });

  it("needs a client on the sale", async () => {
    const t = perClient();
    await expect(
      t.service.processCheckout({
        tenantId: "t1",
        items: [{ serviceId: "svc1", quantity: 1 }],
        promotionCode: "OTONO10",
        payments: [{ method: "card", amount: 3600 }],
      } as any),
    ).rejects.toThrow("Esta promoción tiene un límite de usos por clienta: elige a la clienta para aplicarla.");
    expect(t.usages).toEqual([]);
  });

  it("refuses a client who used it already (a released use does not count)", async () => {
    const t = perClient([{ id: "u0", promotionId: "promo-1", clientId: "c1", releasedAt: null }]);
    await expect(
      t.service.quote({ tenantId: "t1", clientId: "c1", items: [{ serviceId: "svc1", quantity: 1 }], promotionCode: "OTONO10" } as any),
    ).rejects.toThrow("Esta clienta ya ha usado la promoción las veces permitidas.");

    const released = perClient([{ id: "u0", promotionId: "promo-1", clientId: "c1", releasedAt: new Date() }]);
    const q: any = await released.service.quote({
      tenantId: "t1",
      clientId: "c1",
      items: [{ serviceId: "svc1", quantity: 1 }],
      promotionCode: "OTONO10",
    } as any);
    expect(q.promotion.discount).toBe(400);
  });

  it("is checked again in the sale's transaction, after the counter's lock, and for a walk-in client once found", async () => {
    const t = perClient([{ id: "u0", promotionId: "promo-1", clientId: "c-found", releasedAt: null }]);
    // The walk-in client typed at the till is an existing one who used it.
    (t.service as any).walkInClient = jest.fn(async () => "c-found");
    await expect(
      t.service.processCheckout({
        tenantId: "t1",
        clientInfo: { firstName: "Ana", phone: "600000000" },
        items: [{ serviceId: "svc1", quantity: 1 }],
        promotionCode: "OTONO10",
        payments: [{ method: "card", amount: 3600 }],
      } as any),
    ).rejects.toThrow(/ya ha usado la promoción/);
    // The counter was taken first (the row lock), then the count.
    const order = [
      t.prisma.promotion.updateMany.mock.invocationCallOrder[0],
      t.prisma.promotionUsage.count.mock.invocationCallOrder[0],
    ];
    expect(order[0]).toBeLessThan(order[1]);
  });
});

describe("the global limit (maxUses)", () => {
  it("is claimed with a conditional update on usedCount < maxUses; the last use is refused with a 409", async () => {
    const t = till({ promotions: [promo({ maxUses: 2, usedCount: 1 })] });
    const p = t.promotions[0] as TillPromotion;
    await claimPromotionIn(t.prisma, { tenantId: "t1", promotion: p, clientId: null, saleId: "s1", appointmentId: null, discountCents: 100 });
    expect(t.prisma.promotion.updateMany.mock.calls[0][0]).toEqual({
      where: { id: "promo-1", tenantId: "t1", isActive: true, archivedAt: null, maxUses: 2, usedCount: { lt: 2 } },
      data: { usedCount: { increment: 1 } },
    });
    expect(p.usedCount).toBe(2);
    // Another till read it before that use: its claim finds no use left.
    await expect(
      claimPromotionIn(t.prisma, { tenantId: "t1", promotion: { ...p, usedCount: 1 }, clientId: null, saleId: "s2", appointmentId: null, discountCents: 100 }),
    ).rejects.toThrow(ConflictException);
    expect(t.usages.map((u) => u.saleId)).toEqual(["s1"]);
  });

  it("a promotion switched off between the quote and the charge rolls the sale back", async () => {
    const t = till();
    const p = { ...t.promotions[0] } as TillPromotion;
    t.promotions[0].isActive = false;
    await expect(
      claimPromotionIn(t.prisma, { tenantId: "t1", promotion: p, clientId: null, saleId: "s1", appointmentId: null, discountCents: 100 }),
    ).rejects.toThrow("La promoción ya no está activa: cobra sin ella.");
  });
});

// ------------------------------------------------------------------ stacking

describe("with the loyalty reward and a gift card", () => {
  it("promotion first, then the points on what is left, then the gift card pays", async () => {
    const t = till();
    const out: any = await t.service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      items: [{ serviceId: "svc1", quantity: 1 }, { serviceId: "svc2", quantity: 1 }],
      promotionCode: "OTONO10",
      loyaltyRewardId: "11111111-1111-4111-8111-111111111111",
      payments: [
        { method: "gift_card", amount: 2000, giftCardCode: "GIFT-1" },
        { method: "card", amount: 3350 },
      ],
      actor: OWNER,
    } as any);
    // 65,00 - 10 % (6,50) = 58,50; - 5,00 of points = 53,50; 20,00 by gift card + 33,50 by card.
    expect(out.promotion.discount).toBe(650);
    expect(out.loyalty.discount).toBe(500);
    expect(out.total).toBe(5350);
    // The reward sees the ticket after the promotion. The promotion's 6,50
    // is shared by tax base (as the reward is), the rounding cent on the
    // largest line: 4,01 and 2,49.
    expect(t.loyalty.redeemAtSale).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({
        subtotalCents: 5850,
        items: [
          { serviceId: "svc1", price: 3599, quantity: 1 },
          { serviceId: "svc2", price: 2251, quantity: 1 },
        ],
      }),
    );
    expect(t.sales.sales[0]).toMatchObject({ discountCents: 650, promotionDiscountCents: 650, loyaltyDiscountCents: 500, totalCents: 5350 });
    // Both named on the invoice lines, and the invoice comes to what was charged.
    const lines = t.invoiceInputs[0].lines;
    expect(lines.map((l: any) => [l.promotionDiscountCents, l.promotionCode, l.loyaltyDiscountCents])).toEqual([
      [401, "OTONO10", expect.any(Number)],
      [249, "OTONO10", expect.any(Number)],
    ]);
    const invoice = new InvoiceCalculator().compute(lines);
    expect(invoice.totalCents).toBe(5350);
  });
});

// ------------------------------------------------------------------ invoice

describe("the sale's invoice", () => {
  it("names the promotion on each line, shared by tax base over mixed rates, and comes to the cent", async () => {
    const t = till({ promotions: [promo({ type: "FIXED", value: 5 })] });
    const out: any = await t.service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      // 40,00 at 21 % and 10,40 at 4 %.
      items: [{ serviceId: "svc1", quantity: 1 }, { productId: "book", quantity: 1 }],
      promotionCode: "OTONO10",
      payments: [{ method: "cash", amount: 4540 }],
      actor: OWNER,
    } as any);
    expect(out.total).toBe(4540);
    const lines = t.invoiceInputs[0].lines;
    // By tax base: 33,06 and 10,00 -> 3,84 and 1,16 of the 5,00.
    expect(lines).toEqual([
      expect.objectContaining({ description: "Corte", taxRate: 21, discountCents: 384, promotionDiscountCents: 384, promotionCode: "OTONO10" }),
      expect.objectContaining({ description: "Libro de peinados", taxRate: 4, discountCents: 116, promotionDiscountCents: 116, promotionCode: "OTONO10" }),
    ]);
    const invoice = new InvoiceCalculator().compute(lines);
    expect(invoice.totalCents).toBe(4540);
    expect(invoice.lines.map((l) => [l.promotionDiscountCents, l.promotionCode])).toEqual([
      [384, "OTONO10"],
      [116, "OTONO10"],
    ]);
    // The sale's lines say the same as the invoice.
    expect(t.sales.lines.map((l: Row) => [l.discountCents, l.totalCents])).toEqual([
      [384, 3616],
      [116, 924],
    ]);
  });

  it("rounds a percentage half up, like the till's own discounts", async () => {
    const t = till({ promotions: [promo({ value: 15 })] });
    const q: any = await t.service.quote({ tenantId: "t1", items: [{ serviceId: "svc3", quantity: 1 }], promotionCode: "OTONO10" } as any);
    // 15 % of 19,99 = 2,9985 -> 3,00.
    expect(q.promotion.discount).toBe(300);
    expect(q.total).toBe(1699);
  });

  it("a fixed amount above what its lines cost takes them to zero, never below", async () => {
    const t = till({ promotions: [promo({ type: "FIXED", value: 100, applicableServiceIds: ["svc2"] })] });
    const q: any = await t.service.quote({
      tenantId: "t1",
      items: [{ serviceId: "svc1", quantity: 1 }, { serviceId: "svc2", quantity: 1 }],
      promotionCode: "OTONO10",
    } as any);
    expect(q.promotion.discount).toBe(2500);
    expect(q.total).toBe(4000);
  });

  it("with prices as the base, the money charged is the invoice's (tax on top)", async () => {
    const t = till({ fiscal: TAX_ON_TOP, promotions: [promo({ value: 10 })] });
    const q: any = await t.service.quote({ tenantId: "t1", items: [{ serviceId: "svc1", quantity: 1 }], promotionCode: "OTONO10" } as any);
    // 40,00 + 21 % = 48,40; - 10 % = 43,56.
    expect(q.total).toBe(4356);
  });
});

// ------------------------------------------------------------------ refunds

describe("refunds", () => {
  function refundDb(paidLeft: number, usages: Row[]) {
    const promotions = [{ ...promo({ usedCount: 1 }), tenantId: "t1" }];
    const tx: any = {
      payment: { count: jest.fn(async () => paidLeft) },
      promotionUsage: {
        findMany: jest.fn(async ({ where }: any) => usages.filter((u) => u.saleId === where.saleId && !u.releasedAt)),
        updateMany: jest.fn(async ({ where, data }: any) => {
          const u = usages.find((x) => x.id === where.id && !x.releasedAt);
          if (!u) return { count: 0 };
          Object.assign(u, data);
          return { count: 1 };
        }),
      },
      promotion: {
        updateMany: jest.fn(async ({ where, data }: any) => {
          const p = promotions.find((x) => x.id === where.id)!;
          if (!(p.usedCount > where.usedCount.gt)) return { count: 0 };
          p.usedCount -= data.usedCount.decrement;
          return { count: 1 };
        }),
      },
    };
    return { tx, promotions };
  }

  it("the whole sale given back releases its use, once", async () => {
    const usages = [{ id: "use1", promotionId: "promo-1", saleId: "s1", releasedAt: null }];
    const { tx, promotions } = refundDb(0, usages);
    expect(await releaseIfSaleRefundedIn(tx, "t1", "s1")).toBe(1);
    expect(usages[0].releasedAt).toBeInstanceOf(Date);
    expect(promotions[0].usedCount).toBe(0);
    expect(tx.payment.count.mock.calls[0][0].where).toEqual({
      tenantId: "t1",
      status: "paid",
      metadata: { path: ["posSaleId"], equals: "s1" },
    });
    // Again (another payment of the same sale): nothing more.
    expect(await releaseIfSaleRefundedIn(tx, "t1", "s1")).toBe(0);
    expect(promotions[0].usedCount).toBe(0);
  });

  it("while a payment of the sale is still paid (a partial refund), the use stays", async () => {
    const usages = [{ id: "use1", promotionId: "promo-1", saleId: "s1", releasedAt: null }];
    const { tx, promotions } = refundDb(1, usages);
    expect(await releaseIfSaleRefundedIn(tx, "t1", "s1")).toBe(0);
    expect(usages[0].releasedAt).toBeNull();
    expect(promotions[0].usedCount).toBe(1);
  });
});

describe("refused codes never block a sale without one", () => {
  it("a ticket with no code reads no promotion", async () => {
    const t = till();
    const q: any = await t.service.quote({ tenantId: "t1", items: [{ serviceId: "svc1", quantity: 1 }] } as any);
    expect(q.promotion).toBeNull();
    expect(t.prisma.promotion.findFirst).not.toHaveBeenCalled();
  });

  it("a code that takes nothing off is refused", async () => {
    const t = till({ promotions: [promo({ value: 0 })] });
    await expect(
      t.service.quote({ tenantId: "t1", items: [{ serviceId: "svc1", quantity: 1 }], promotionCode: "OTONO10" } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
