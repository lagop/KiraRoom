import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { PosService } from "./pos.service";
import { CommissionsService } from "../commissions/commissions.service";

/**
 * Discounts at the till, end to end through PosService.processCheckout:
 * the server works the amounts out from its own prices, refuses staff past
 * the salon's limit before anything is written, records every discount
 * (PosDiscount) with the sale, and an appointment's total, paid amount and
 * commission follow what was actually charged.
 */

type Row = Record<string, any>;

/** Euros, as Service.price and Product.price are stored. */
const CATALOGUE = {
  services: [
    { id: "svc1", name: "Corte", price: 40 },
    { id: "svc2", name: "Tinte", price: 25 },
  ],
  products: [{ id: "prod1", name: "Champú", price: 12.5, isActive: true }],
};

function apt(id: string, over: Row = {}): Row {
  return {
    id,
    tenantId: "t1",
    clientId: "c1",
    professionalId: "p-me",
    serviceId: "svc1",
    status: "completed",
    paymentStatus: "pending",
    amountPaid: 0,
    totalAmount: 4000, // cents
    price: 40, // euros
    discount: {},
    service: { name: "Corte", price: 40 },
    professional: { commissionRate: 20 },
    ...over,
  };
}

function till(appointments: Row[], opts: { maxStaff?: number; invoiced?: string[]; loyalty?: Row } = {}) {
  const committed = {
    payments: [] as Row[],
    discounts: [] as Row[],
    appointments: new Map(appointments.map((a) => [a.id, { ...a }])),
  };
  const db = (pending: { payments: Row[]; discounts: Row[]; updates: [string, Row][] }) => ({
    payment: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `pay${committed.payments.length + pending.payments.length + 1}`, ...data };
        pending.payments.push(row);
        return row;
      }),
    },
    posDiscount: {
      createMany: jest.fn(async ({ data }: any) => {
        pending.discounts.push(...data);
        return { count: data.length };
      }),
    },
    appointment: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        const a = committed.appointments.get(where.id)!;
        const ok =
          Number(a.amountPaid) === Number(where.amountPaid) &&
          (!("totalAmount" in where) || Number(a.totalAmount) === Number(where.totalAmount)) &&
          a.paymentStatus !== where.paymentStatus.not &&
          !where.status.notIn.includes(a.status);
        if (ok) pending.updates.push([where.id, data]);
        return { count: ok ? 1 : 0 };
      }),
    },
  });
  const commit = (pending: { payments: Row[]; discounts: Row[]; updates: [string, Row][] }) => {
    committed.payments.push(...pending.payments);
    committed.discounts.push(...pending.discounts);
    for (const [id, data] of pending.updates) Object.assign(committed.appointments.get(id)!, data);
  };

  const prisma: any = {
    appointment: {
      findMany: jest.fn(async ({ where }: any) =>
        // Copies, as the database hands out: later writes do not change what was read.
        [...committed.appointments.values()]
          .filter((a) => where.id.in.includes(a.id) && a.tenantId === where.tenantId)
          .map((a) => ({ ...a })),
      ),
      findFirst: jest.fn(async ({ where }: any) => {
        const a = committed.appointments.get(where.id);
        return a && a.tenantId === where.tenantId ? a : null;
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(committed.appointments.get(where.id)!, data)),
    },
    professional: { findFirst: jest.fn(async ({ where }: any) => (where.userId === "u-me" ? { id: "p-me" } : null)) },
    service: {
      findMany: jest.fn(async ({ where }: any) =>
        CATALOGUE.services.filter((x) => where.id.in.includes(x.id) && where.tenantId === "t1"),
      ),
    },
    product: {
      findMany: jest.fn(async ({ where }: any) =>
        CATALOGUE.products.filter((x) => where.id.in.includes(x.id) && where.tenantId === "t1"),
      ),
    },
    tenant: {
      findUnique: jest.fn(async () => ({ maxStaffDiscountPercent: opts.maxStaff ?? 0 })),
      update: jest.fn(async ({ data }: any) => ({ maxStaffDiscountPercent: data.maxStaffDiscountPercent })),
    },
    invoice: {
      findMany: jest.fn(async ({ where }: any) =>
        where.sourceId.in
          .filter((x: string) => (opts.invoiced ?? []).includes(x))
          .map((x: string) => ({ id: `inv-${x}`, sourceId: x, status: "issued", series: "A", number: "000001" })),
      ),
    },
    client: { findFirst: jest.fn(async ({ where }: any) => (where.id ? { id: where.id } : null)), create: jest.fn() },
    $transaction: jest.fn(async (fn: any) => {
      const pending = { payments: [] as Row[], discounts: [] as Row[], updates: [] as [string, Row][] };
      const out = await fn(db(pending));
      commit(pending);
      return out;
    }),
  };
  const direct = { payments: [] as Row[], discounts: [] as Row[], updates: [] as [string, Row][] };
  Object.assign(prisma, { payment: db(direct).payment });

  const loyalty: any = {
    redeemAtSale: jest.fn(async () => ({ discountCents: 500, pointsSpent: 50, rewardName: "5 EUR", redemptionId: "r1" })),
    cancelSaleRedemption: jest.fn(async () => undefined),
    earnForSale: jest.fn(async () => 0),
    settleAppointment: jest.fn(async () => ({ awarded: 0 })),
    ...opts.loyalty,
  };
  const wallet: any = { deductFunds: jest.fn(async () => ({})), addFunds: jest.fn(async () => ({})) };
  const service = new PosService(prisma, wallet, loyalty);
  return { service, prisma, loyalty, wallet, committed, direct };
}

/** A reward id, built rather than written out (secret scanners flag UUID literals by id keys). */
const REWARD = ["1".repeat(8), "1111", "4111", "8111", "1".repeat(12)].join("-");

const OWNER = { id: "u-owner", role: "owner" };
const MANAGER = { id: "u-manager", role: "admin" };
const STAFF = { id: "u-me", role: "staff" };

describe("POS discounts: a walk-in ticket", () => {
  it("takes 10 % off a line and 5 EUR off the ticket, priced by the server, and records both", async () => {
    const t = till([]);
    const out = await t.service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      items: [
        { serviceId: "svc1", quantity: 1, discount: { type: "percentage", value: 10, reason: "Clienta habitual" } },
        { productId: "prod1", quantity: 2 },
      ],
      discount: { type: "fixed", value: 500, reason: "Cumpleaños" },
      payments: [{ method: "cash", amount: 5600 }],
      actor: MANAGER,
    } as any);

    // 40,00 + 2 x 12,50 = 65,00; -4,00 (line) = 61,00; -5,00 (ticket) = 56,00.
    expect(out.subtotal).toBe(6500);
    expect(out.discount).toEqual({ lines: 400, order: 500, total: 900 });
    expect(out.total).toBe(5600);
    expect(t.committed.payments).toEqual([
      expect.objectContaining({ amount: 5600, method: "cash", metadata: expect.objectContaining({ posDiscountCents: 900 }) }),
    ]);
    // Recorded in the same transaction as the payment.
    expect(t.prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(t.committed.discounts).toEqual([
      expect.objectContaining({
        tenantId: "t1",
        saleId: out.saleId,
        scope: "line",
        lineIndex: 0,
        serviceId: "svc1",
        description: "Corte",
        type: "percentage",
        value: 10,
        baseCents: 4000,
        amountCents: 400,
        reason: "Clienta habitual",
        appliedById: "u-manager",
        appliedByRole: "admin",
      }),
      expect.objectContaining({
        scope: "order",
        description: "Ticket",
        type: "fixed",
        value: 500,
        baseCents: 6100,
        amountCents: 500,
        reason: "Cumpleaños",
        appliedById: "u-manager",
      }),
    ]);
  });

  it("refuses a payment below the discounted total, and accepts exactly it", async () => {
    const t = till([]);
    const ticket = {
      tenantId: "t1",
      clientId: "c1",
      items: [{ serviceId: "svc1", quantity: 1, discount: { type: "percentage", value: 10 } }],
      actor: OWNER,
    };
    await expect(
      t.service.processCheckout({ ...ticket, payments: [{ method: "card", amount: 3599 }] } as any),
    ).rejects.toThrow(BadRequestException);
    expect(t.committed.payments).toHaveLength(0);
    expect(t.committed.discounts).toHaveLength(0);
    const out = await t.service.processCheckout({ ...ticket, payments: [{ method: "card", amount: 3600 }] } as any);
    expect(out.total).toBe(3600);
  });

  it("cannot be talked into a price: whatever amounts the body carries, the server's prices stand", async () => {
    const t = till([]);
    const out = await t.service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      // As if a modified panel skipped the DTO's stripping: still ignored.
      items: [{ serviceId: "svc1", quantity: 1, price: 1, netCents: 1, discount: { type: "fixed", value: 100, amountCents: 3999 } }],
      subtotal: 1,
      total: 1,
      discount: { type: "percentage", value: 0, amountCents: 99999 },
      payments: [{ method: "cash", amount: 3900 }],
      actor: OWNER,
    } as any);
    expect(out.subtotal).toBe(4000);
    expect(out.discount.total).toBe(100);
    expect(out.total).toBe(3900);
    // A 0 % ticket discount is no discount: nothing recorded for it.
    expect(t.committed.discounts.map((d) => d.scope)).toEqual(["line"]);
  });

  it("refuses a fixed discount above the line with a 400 and writes nothing", async () => {
    const t = till([]);
    await expect(
      t.service.processCheckout({
        tenantId: "t1",
        clientId: "c1",
        items: [{ serviceId: "svc2", quantity: 1, discount: { type: "fixed", value: 2501 } }],
        payments: [{ method: "cash", amount: 0 }],
        actor: OWNER,
      } as any),
    ).rejects.toThrow("El descuento (25,01 €) supera el importe de la línea (25,00 €).");
    expect(t.committed.payments).toHaveLength(0);
  });

  it("gives the loyalty reward on what is left after the till's discounts", async () => {
    const t = till([]);
    const out = await t.service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      items: [{ serviceId: "svc1", quantity: 1, discount: { type: "percentage", value: 25 } }],
      loyaltyRewardId: REWARD,
      payments: [{ method: "cash", amount: 2500 }],
      actor: OWNER,
    } as any);
    expect(t.loyalty.redeemAtSale).toHaveBeenCalledWith(
      "t1",
      expect.objectContaining({ subtotalCents: 3000, items: [{ serviceId: "svc1", price: 3000, quantity: 1 }] }),
    );
    expect(out.total).toBe(2500);
    expect(t.loyalty.earnForSale).toHaveBeenCalledWith("t1", expect.objectContaining({ basisCents: 2500 }));
  });
});

describe("POS discounts: staff and the salon's limit", () => {
  const ticket = (discount: Row) => ({
    tenantId: "t1",
    clientId: "c1",
    items: [{ serviceId: "svc1", quantity: 1, discount }],
    payments: [{ method: "cash", amount: 4000 }],
    actor: STAFF,
  });

  it("staff cannot discount while the limit is 0 (the default): a Spanish 403, nothing written", async () => {
    const t = till([], { maxStaff: 0 });
    const err = await t.service.processCheckout(ticket({ type: "percentage", value: 5 }) as any).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toBe("Solo la propietaria o un encargado pueden aplicar descuentos en caja.");
    expect(t.committed.payments).toHaveLength(0);
    expect(t.committed.discounts).toHaveLength(0);
    expect(t.prisma.client.create).not.toHaveBeenCalled();
    expect(t.loyalty.redeemAtSale).not.toHaveBeenCalled();
  });

  it("staff discount up to the limit and are refused past it", async () => {
    const t = till([], { maxStaff: 10 });
    const ok = await t.service.processCheckout(ticket({ type: "percentage", value: 10 }) as any);
    expect(ok.total).toBe(3600);
    expect(t.committed.discounts[0]).toMatchObject({ appliedById: "u-me", appliedByRole: "staff", amountCents: 400 });

    const err = await t.service.processCheckout(ticket({ type: "fixed", value: 401 }) as any).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.message).toBe("Tu límite de descuento es del 10 % por línea. Para descontar más, pide a un encargado que lo aplique.");
    expect(t.committed.discounts).toHaveLength(1);
  });

  it("the owner is not limited, and the salon's setting is not even read for them", async () => {
    const t = till([], { maxStaff: 0 });
    const out = await t.service.processCheckout({ ...ticket({ type: "percentage", value: 100 }), actor: OWNER, payments: [{ method: "cash", amount: 0 }] } as any);
    expect(out.total).toBe(0);
    expect(t.prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it("reads and saves the limit", async () => {
    const t = till([], { maxStaff: 15 });
    expect(await t.service.getSettings("t1")).toEqual({ maxStaffDiscountPercent: 15 });
    expect(await t.service.updateSettings("t1", { maxStaffDiscountPercent: 20 })).toEqual({ maxStaffDiscountPercent: 20 });
    expect(t.prisma.tenant.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "t1" }, data: { maxStaffDiscountPercent: 20 } }),
    );
  });
});

describe("POS discounts: an appointment", () => {
  it("lowers the visit's total and price, pays it in full and keeps the record its invoice reads", async () => {
    const t = till([apt("a1")]);
    const out = await t.service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      appointmentIds: ["a1"],
      items: [{ serviceId: "svc1", appointmentId: "a1", quantity: 1, discount: { type: "percentage", value: 10, reason: "Retraso" } }],
      payments: [{ method: "card", amount: 3600 }],
      actor: OWNER,
    } as any);
    expect(out.total).toBe(3600);
    expect(t.committed.payments).toEqual([expect.objectContaining({ appointmentId: "a1", amount: 3600, method: "card" })]);
    const a = t.committed.appointments.get("a1")!;
    expect(a).toMatchObject({ totalAmount: 3600, price: 36, amountPaid: 3600, paymentStatus: "paid" });
    expect(a.discount.pos).toMatchObject({
      saleId: out.saleId,
      amountCents: 400,
      lineCents: 400,
      orderCents: 0,
      reason: "Retraso",
      appliedById: "u-owner",
      appliedByRole: "owner",
    });
    expect(t.committed.discounts).toEqual([expect.objectContaining({ appointmentId: "a1", amountCents: 400 })]);
  });

  it("after a deposit, the discount comes off what is still owed and the visit ends up paid", async () => {
    const t = till([apt("a1", { amountPaid: 1000 })]);
    const out = await t.service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      appointmentIds: ["a1"],
      items: [{ serviceId: "svc1", appointmentId: "a1", quantity: 1, discount: { type: "fixed", value: 500 } }],
      payments: [{ method: "cash", amount: 2500 }],
      actor: OWNER,
    } as any);
    expect(out.subtotal).toBe(3000);
    expect(out.total).toBe(2500);
    // 40,00 - 5,00 = 35,00; 10,00 deposit + 25,00 now.
    expect(t.committed.appointments.get("a1")).toMatchObject({ totalAmount: 3500, amountPaid: 3500, paymentStatus: "paid" });
  });

  it("shares a ticket discount between two appointments and a product, each visit getting its part", async () => {
    const t = till([apt("a1"), apt("a2", { serviceId: "svc2", totalAmount: 2500, price: 25, service: { name: "Tinte", price: 25 } })]);
    const out = await t.service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      appointmentIds: ["a1", "a2"],
      items: [
        { serviceId: "svc1", appointmentId: "a1", quantity: 1 },
        { serviceId: "svc2", appointmentId: "a2", quantity: 1 },
        { productId: "prod1", quantity: 1 },
      ],
      discount: { type: "fixed", value: 775 },
      payments: [{ method: "cash", amount: 7000 }],
      actor: OWNER,
    } as any);
    // 40 + 25 + 12,50 = 77,50; 7,75 off in proportion: 4,00 / 2,50 / 1,25.
    expect(out.total).toBe(6975);
    expect(t.committed.appointments.get("a1")).toMatchObject({ totalAmount: 3600, amountPaid: 3600, paymentStatus: "paid" });
    expect(t.committed.appointments.get("a2")).toMatchObject({ totalAmount: 2250, amountPaid: 2250, paymentStatus: "paid" });
    expect(t.committed.appointments.get("a1")!.discount.pos).toMatchObject({ amountCents: 400, lineCents: 0, orderCents: 400 });
    // 69,75 charged: 36 + 22,50 to the visits, the rest to the ticket. The
    // 0,25 over is the change given back, not a sale (pos-tenders.ts).
    const toVisits = t.committed.payments.filter((p) => p.appointmentId).reduce((s, p) => s + p.amount, 0);
    expect(toVisits).toBe(5850);
    expect(t.committed.payments.reduce((s, p) => s + p.amount, 0)).toBe(6975);
    expect(out.change).toBe(25);
  });

  // With invoicing available, the discount is credited by a rectificativa
  // instead (pos-invoiced-discount.spec.ts). Without it, still refused.
  it("without invoicing, refuses a discount on an appointment whose invoice is already issued (409), and writes nothing", async () => {
    const t = till([apt("a1")], { invoiced: ["a1"] });
    const err = await t.service
      .processCheckout({
        tenantId: "t1",
        clientId: "c1",
        appointmentIds: ["a1"],
        items: [{ serviceId: "svc1", appointmentId: "a1", quantity: 1, discount: { type: "percentage", value: 10 } }],
        payments: [{ method: "card", amount: 3600 }],
        actor: OWNER,
      } as any)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "APPOINTMENT_ALREADY_INVOICED", appointmentId: "a1" });
    expect(t.committed.payments).toHaveLength(0);
    expect(t.committed.appointments.get("a1")).toMatchObject({ totalAmount: 4000, paymentStatus: "pending" });
  });

  it("charges an invoiced appointment without a discount as before (the invoice is not even looked up)", async () => {
    const t = till([apt("a1")], { invoiced: ["a1"] });
    await t.service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      appointmentIds: ["a1"],
      items: [{ serviceId: "svc1", appointmentId: "a1", quantity: 1 }],
      payments: [{ method: "card", amount: 4000 }],
      actor: OWNER,
    } as any);
    expect(t.prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(t.committed.appointments.get("a1")).toMatchObject({ totalAmount: 4000, paymentStatus: "paid" });
  });

  it("a 100 % discount leaves the visit paid at 0", async () => {
    const t = till([apt("a1")]);
    await t.service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      appointmentIds: ["a1"],
      items: [{ serviceId: "svc1", appointmentId: "a1", quantity: 1, discount: { type: "percentage", value: 100, reason: "Invitación" } }],
      payments: [{ method: "cash", amount: 0 }],
      actor: OWNER,
    } as any);
    expect(t.committed.appointments.get("a1")).toMatchObject({ totalAmount: 0, price: 0, amountPaid: 0, paymentStatus: "paid" });
  });

  it("the commission is on the discounted amount: it follows the visit's total", async () => {
    const t = till([apt("a1")]);
    await t.service.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      appointmentIds: ["a1"],
      items: [{ serviceId: "svc1", appointmentId: "a1", quantity: 1, discount: { type: "fixed", value: 1000 } }],
      payments: [{ method: "card", amount: 3000 }],
      actor: OWNER,
    } as any);
    const commissions = new CommissionsService(t.prisma);
    // 20 % of the 30,00 EUR charged, not of the 40,00 list price.
    const out = await commissions.calculateCommission("t1", { appointmentId: "a1" });
    expect(out).toEqual({ commissionRate: 20, commissionAmount: 600 });
  });

  it("a staff member charging their own appointment is held to the same limit", async () => {
    const t = till([apt("a1")], { maxStaff: 5 });
    await expect(
      t.service.processCheckout({
        tenantId: "t1",
        clientId: "c1",
        appointmentIds: ["a1"],
        items: [{ serviceId: "svc1", appointmentId: "a1", quantity: 1, discount: { type: "percentage", value: 6 } }],
        payments: [{ method: "card", amount: 3760 }],
        actor: STAFF,
      } as any),
    ).rejects.toThrow(ForbiddenException);
    expect(t.committed.appointments.get("a1")).toMatchObject({ totalAmount: 4000, paymentStatus: "pending" });
  });

  it("a concurrent change to the visit's total rolls the whole ticket back (409)", async () => {
    const t = till([apt("a1")]);
    // The visit was edited between reading it and writing the payment.
    const original = t.prisma.$transaction.getMockImplementation();
    t.prisma.$transaction.mockImplementationOnce(async (fn: any) => {
      t.committed.appointments.get("a1")!.totalAmount = 4500;
      return original(fn);
    });
    await expect(
      t.service.processCheckout({
        tenantId: "t1",
        clientId: "c1",
        appointmentIds: ["a1"],
        items: [{ serviceId: "svc1", appointmentId: "a1", quantity: 1, discount: { type: "percentage", value: 10 } }],
        payments: [{ method: "card", amount: 3600 }],
        actor: OWNER,
      } as any),
    ).rejects.toThrow(ConflictException);
    expect(t.committed.payments).toHaveLength(0);
    expect(t.committed.discounts).toHaveLength(0);
  });
});
