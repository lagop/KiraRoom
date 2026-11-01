import { ConflictException, ForbiddenException } from "@nestjs/common";
import { InvoiceSource } from "@prisma/client";
import { PosService } from "./pos.service";
import { InvoiceService } from "../invoices/invoices.service";
import { InvoiceCalculator } from "../invoices/invoice-calculator.service";
import { invoiceStore } from "../invoices/invoice-store.testing";
import { CommissionsService } from "../commissions/commissions.service";
import { cashDrawerRaw, saleTables } from "./pos-test-kit.testing";

/**
 * A discount given at the till to an appointment whose invoice is already
 * issued. It used to be refused (409). The invoice cannot be edited (with
 * VERI*FACTU it is chained and sent), so the discount is now credited by a
 * rectificativa by difference, issued in the sale's transaction through the
 * ordinary rectification path (series R, numbered, linked to the original
 * line by line, counted in what is left to credit), recorded with the
 * discount, while the visit's total and commission follow the discount as
 * before. Still refused when the invoice is cancelled or has less left than
 * the discount.
 */

type Row = Record<string, any>;

const OWNER = { id: "u-owner", role: "owner" };
const STAFF = { id: "u-me", role: "staff" };

function apt(over: Row = {}): Row {
  return {
    id: "a1",
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

async function setup(opts: { pricesIncludeTax?: boolean; maxStaff?: number; withInvoices?: boolean } = {}) {
  const fiscalSettings = { defaultSeries: "A", defaultTaxRate: 21, pricesIncludeTax: opts.pricesIncludeTax ?? true };
  const store = invoiceStore(fiscalSettings);
  const appointments = new Map<string, Row>([["a1", apt()]]);
  const payments: Row[] = [];
  const discounts: Row[] = [];
  const prisma: any = store.prisma;
  // The invoice numbering keeps its raw queries; the cash drawer is open.
  const invoiceRaw = prisma.$queryRaw;
  const sales = saleTables();
  Object.assign(prisma, {
    tenant: {
      findUnique: jest.fn(async () => ({
        fiscalMode: "none",
        fiscalSettings,
        maxStaffDiscountPercent: opts.maxStaff ?? 0,
        timezone: "Europe/Madrid",
      })),
    },
    ...sales,
    $queryRaw: cashDrawerRaw(sales.store, invoiceRaw),
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
        const ok =
          Number(a.amountPaid) === Number(where.amountPaid) &&
          (!("totalAmount" in where) || Number(a.totalAmount) === Number(where.totalAmount));
        if (ok) Object.assign(a, data);
        return { count: ok ? 1 : 0 };
      }),
      update: jest.fn(async ({ where, data }: any) => Object.assign(appointments.get(where.id)!, data)),
    },
    professional: {
      findFirst: jest.fn(async ({ where }: any) => (where.userId === "u-me" ? { id: "p-me" } : null)),
      findMany: jest.fn(async () => []),
    },
    service: { findMany: jest.fn(async () => []) },
    product: { findMany: jest.fn(async () => []) },
    client: { findFirst: jest.fn(async ({ where }: any) => ({ id: where.id })) },
    payment: { create: jest.fn(async ({ data }: any) => (payments.push({ id: `pay${payments.length + 1}`, ...data }), payments.at(-1))) },
    posDiscount: { createMany: jest.fn(async ({ data }: any) => (discounts.push(...data), { count: data.length })) },
  });
  // All or nothing, like Postgres: a transaction that throws leaves no trace.
  prisma.$transaction = jest.fn(async (fn: any) => {
    const before = {
      invoices: new Map(store.invoices),
      payments: payments.length,
      discounts: discounts.length,
      appointments: new Map([...appointments].map(([k, v]) => [k, { ...v }])),
    };
    try {
      return await fn(prisma);
    } catch (err) {
      store.invoices.clear();
      before.invoices.forEach((v, k) => store.invoices.set(k, v));
      payments.length = before.payments;
      discounts.length = before.discounts;
      before.appointments.forEach((v, k) => appointments.set(k, v));
      throw err;
    }
  });

  const fiscal = { dispatchInvoice: jest.fn(async () => undefined) };
  const invoices = new InvoiceService(prisma, new InvoiceCalculator(), fiscal as any);
  jest.spyOn(invoices, "afterIssue");
  const wallet: any = { deductFunds: jest.fn(), addFunds: jest.fn() };
  const pos = opts.withInvoices === false ? new PosService(prisma, wallet) : new PosService(prisma, wallet, undefined, invoices);

  // The visit's invoice, issued when it was completed: 40,00 EUR, one line.
  const { id: invoiceId } = await invoices.create({
    tenantId: "t1",
    recipientName: "Ana Prueba",
    lines: [{ description: "Corte", quantity: 1, unitPriceCents: 4000, taxRate: 21, taxIncluded: fiscalSettings.pricesIncludeTax, serviceId: "svc1" }],
    source: { type: InvoiceSource.appointment, id: "a1" },
  });
  const original = store.invoices.get(invoiceId);
  const checkout = (discount: Row, pay: number, actor: Row = OWNER) =>
    pos.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      appointmentIds: ["a1"],
      items: [{ serviceId: "svc1", appointmentId: "a1", quantity: 1, discount }],
      payments: [{ method: "card", amount: pay }],
      actor,
    } as any);
  const rectificativas = () => [...store.invoices.values()].filter((i) => i.series === "R");
  return { prisma, store, invoices, pos, original, appointments, payments, discounts, checkout, rectificativas };
}

describe("a till discount on an appointment already invoiced", () => {
  it("is applied, and a rectificativa by difference credits it: tax included, 4,00 = 3,31 + 0,69", async () => {
    const t = await setup();
    const sale: any = await t.checkout({ type: "percentage", value: 10, reason: "clienta habitual" }, 3600);

    const [rect] = t.rectificativas();
    expect(rect).toMatchObject({
      series: "R",
      number: "000001",
      totalCents: -400,
      subtotalCents: -331,
      taxBreakdown: [{ rate: 21, baseCents: -331, taxCents: -69 }],
      recipientName: "Ana Prueba",
    });
    expect(rect.notes).toBe(`Rectificación de A000001: Descuento en caja (venta ${sale.saleId})`);
    expect(rect.lines).toHaveLength(1);
    expect(rect.lines[0]).toMatchObject({
      description: "Descuento: Corte",
      quantity: 1,
      taxIncluded: true,
      rectifiesLineId: t.original.lines[0].id,
      serviceId: "svc1",
    });
    // The original is left as issued; the two together say what was charged.
    expect(t.original.totalCents + rect.totalCents).toBe(3600);
    expect(t.store.locks).toEqual([t.original.id]);
    expect(t.invoices.afterIssue).toHaveBeenCalledWith({ id: rect.id, fiscalMode: "none" });

    // The sale, the visit and the discount's record, as for any till discount.
    expect(sale.rectifications).toEqual([{ appointmentId: "a1", invoiceId: rect.id }]);
    expect(t.payments.reduce((s, p) => s + p.amount, 0)).toBe(3600);
    expect(t.appointments.get("a1")).toMatchObject({ totalAmount: 3600, price: 36, amountPaid: 3600, paymentStatus: "paid" });
    expect(t.appointments.get("a1")!.discount.pos).toMatchObject({ amountCents: 400, rectificationInvoiceId: rect.id });
    expect(t.discounts).toHaveLength(1);
    expect(t.discounts[0]).toMatchObject({
      scope: "line",
      appointmentId: "a1",
      amountCents: 400,
      reason: "clienta habitual",
      appliedById: "u-owner",
      appliedByRole: "owner",
      rectificationInvoiceId: rect.id,
    });

    // The commission follows what was charged: 20 % of 36,00.
    const commission = await new CommissionsService(t.prisma).calculateCommission("t1", { appointmentId: "a1" });
    expect(commission).toEqual({ commissionRate: 20, commissionAmount: 720 });
  });

  it("with the tax on top: the till works in money, 12,10 off is 10,00 + 2,10 credited", async () => {
    const t = await setup({ pricesIncludeTax: false });
    expect(t.original.totalCents).toBe(4840);
    // The visit costs 48,40 at the till (its invoice total); 12,10 off leaves 36,30.
    await t.checkout({ type: "fixed", value: 1210 }, 3630);
    const [rect] = t.rectificativas();
    expect(rect).toMatchObject({ subtotalCents: -1000, totalCents: -1210 });
    expect(rect.lines[0]).toMatchObject({ taxIncluded: false, taxCents: -210, totalCents: -1210 });
  });

  it("a ticket discount on the visit is credited too, and its record names the rectificativa", async () => {
    const t = await setup();
    await t.pos.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      appointmentIds: ["a1"],
      items: [{ serviceId: "svc1", appointmentId: "a1", quantity: 1 }],
      discount: { type: "fixed", value: 500 },
      payments: [{ method: "cash", amount: 3500 }],
      actor: OWNER,
    } as any);
    const [rect] = t.rectificativas();
    expect(rect.totalCents).toBe(-500);
    expect(t.discounts).toEqual([expect.objectContaining({ scope: "order", amountCents: 500, rectificationInvoiceId: rect.id })]);
  });

  it("keeps the staff limit: past it, 403 and no rectificativa; within it, issued", async () => {
    const t = await setup({ maxStaff: 5 });
    await expect(t.checkout({ type: "percentage", value: 6 }, 3760, STAFF)).rejects.toBeInstanceOf(ForbiddenException);
    expect(t.rectificativas()).toHaveLength(0);
    expect(t.payments).toHaveLength(0);

    await t.checkout({ type: "percentage", value: 5 }, 3800, STAFF);
    expect(t.rectificativas()[0].totalCents).toBe(-200);
    expect(t.discounts[0]).toMatchObject({ appliedById: "u-me", appliedByRole: "staff" });
  });

  it("refuses (409) a discount larger than what is left to credit, and writes nothing", async () => {
    const t = await setup();
    // 38,00 of the 40,00 were credited already.
    await t.invoices.rectifyByAmountIn(t.prisma, "t1", t.original.id, 3800, "Devolución parcial");
    const err = await t.checkout({ type: "percentage", value: 10 }, 3600).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "APPOINTMENT_INVOICE_NOT_CREDITABLE",
      appointmentId: "a1",
      message:
        "La factura de esta cita (A000001) ya está emitida y el descuento no cabe en una rectificativa: El abono (4,00 €) supera lo que queda por abonar de la factura (2,00 €). Cóbrala sin descuento o con uno menor.",
    });
    expect(t.rectificativas()).toHaveLength(1);
    expect(t.payments).toHaveLength(0);
    expect(t.discounts).toHaveLength(0);
    expect(t.appointments.get("a1")).toMatchObject({ totalAmount: 4000, paymentStatus: "pending" });
  });

  it("refuses (409) when the invoice is fully credited already", async () => {
    const t = await setup();
    await t.invoices.emitRectification("t1", t.original.id, undefined, "Anulada");
    const err = await t.checkout({ type: "fixed", value: 100 }, 3900).catch((e) => e);
    expect(err.getResponse()).toMatchObject({ code: "APPOINTMENT_INVOICE_NOT_CREDITABLE" });
    expect(err.getResponse().message).toContain("La factura ya está abonada entera");
    expect(t.payments).toHaveLength(0);
  });

  it("refuses (409) when the invoice is cancelled", async () => {
    const t = await setup();
    await t.invoices.cancel("t1", t.original.id, "error");
    const err = await t.checkout({ type: "fixed", value: 100 }, 3900).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({
      code: "APPOINTMENT_INVOICE_CANCELLED",
      message: "La factura de esta cita (A000001) está anulada: no se le puede aplicar un descuento en caja. Cóbrala sin descuento.",
    });
    expect(t.rectificativas()).toHaveLength(0);
  });

  it("a rectificativa issued between the check and the sale: 409, and the whole sale rolls back", async () => {
    const t = await setup();
    const check = t.invoices.assertCreditable.bind(t.invoices);
    jest.spyOn(t.invoices, "assertCreditable").mockImplementationOnce(async (...args) => {
      const credited = await check(...args);
      // Someone credits 38,00 right after the check.
      await t.invoices.rectifyByAmountIn(t.prisma, "t1", t.original.id, 3800, "otra caja");
      return credited;
    });
    const err = await t.checkout({ type: "percentage", value: 10 }, 3600).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.getResponse()).toMatchObject({ code: "APPOINTMENT_INVOICE_NOT_CREDITABLE" });
    expect(t.rectificativas()).toHaveLength(1);
    expect(t.payments).toHaveLength(0);
    expect(t.appointments.get("a1")).toMatchObject({ totalAmount: 4000, paymentStatus: "pending" });
    expect(t.invoices.afterIssue).toHaveBeenCalledTimes(1); // the original only
  });

  it("without a discount, an invoiced appointment is charged as before: no rectificativa", async () => {
    const t = await setup();
    await t.pos.processCheckout({
      tenantId: "t1",
      clientId: "c1",
      appointmentIds: ["a1"],
      items: [{ serviceId: "svc1", appointmentId: "a1", quantity: 1 }],
      payments: [{ method: "card", amount: 4000 }],
      actor: OWNER,
    } as any);
    expect(t.rectificativas()).toHaveLength(0);
    expect(t.appointments.get("a1")).toMatchObject({ totalAmount: 4000, paymentStatus: "paid" });
  });
});
