import { Prisma } from "@prisma/client";
import { appointmentInvoiceLine, appointmentInvoiceLines } from "./appointment-invoice-pricing";
import { InvoiceCalculator } from "./invoice-calculator.service";

const calc = new InvoiceCalculator();
const appt = { price: new Prisma.Decimal("30.00"), serviceId: "svc-1", service: { name: "Corte" } };

describe("appointmentInvoiceLine", () => {
  it("a salon without the setting keeps tax added on top of the price", () => {
    const line = appointmentInvoiceLine(appt, {});
    expect(line).toEqual({
      description: "Corte",
      quantity: 1,
      unitPriceCents: 3000,
      taxRate: 21,
      taxIncluded: false,
      serviceId: "svc-1",
    });
    const r = calc.compute([line]);
    expect(r.subtotalCents).toBe(3000);
    expect(r.totalCents).toBe(3630);
  });

  it("pricesIncludeTax false: 30,00 + 6,30 IVA = 36,30", () => {
    const line = appointmentInvoiceLine(appt, { pricesIncludeTax: false });
    expect(line.taxIncluded).toBe(false);
    const r = calc.compute([line]);
    expect(r.subtotalCents).toBe(3000);
    expect(r.totalCents).toBe(3630);
    expect(r.taxBreakdown).toEqual([{ rate: 21, baseCents: 3000, taxCents: 630 }]);
  });

  it("pricesIncludeTax true: the invoice total is the price, 24,79 + 5,21 = 30,00", () => {
    const line = appointmentInvoiceLine(appt, { pricesIncludeTax: true });
    expect(line.taxIncluded).toBe(true);
    const r = calc.compute([line]);
    expect(r.totalCents).toBe(3000);
    expect(r.subtotalCents).toBe(2479);
    expect(r.taxBreakdown).toEqual([{ rate: 21, baseCents: 2479, taxCents: 521 }]);
  });

  it("IGIC 7 %, prices included: 28,04 + 1,96 = 30,00; on top: 30,00 + 2,10", () => {
    const included = calc.compute([appointmentInvoiceLine(appt, { defaultTaxRate: 7, pricesIncludeTax: true })]);
    expect(included.taxBreakdown).toEqual([{ rate: 7, baseCents: 2804, taxCents: 196 }]);
    expect(included.totalCents).toBe(3000);
    const onTop = calc.compute([appointmentInvoiceLine(appt, { defaultTaxRate: 7, pricesIncludeTax: false })]);
    expect(onTop.taxBreakdown).toEqual([{ rate: 7, baseCents: 3000, taxCents: 210 }]);
    expect(onTop.totalCents).toBe(3210);
  });

  it("only a true boolean means included: a stray string or null keeps tax on top", () => {
    expect(appointmentInvoiceLine(appt, { pricesIncludeTax: "true" }).taxIncluded).toBe(false);
    expect(appointmentInvoiceLine(appt, { pricesIncludeTax: null }).taxIncluded).toBe(false);
  });

  it("converts Appointment.price from euros to cents", () => {
    const line = appointmentInvoiceLine({ ...appt, price: new Prisma.Decimal("45.5") }, {});
    expect(line.unitPriceCents).toBe(4550);
    expect(appointmentInvoiceLine({ ...appt, price: "19.99" }, {}).unitPriceCents).toBe(1999);
  });

  it("uses the salon's defaultTaxRate (IGIC 7, exempt 0), else 21", () => {
    expect(appointmentInvoiceLine(appt, { defaultTaxRate: 7 }).taxRate).toBe(7);
    expect(appointmentInvoiceLine(appt, { defaultTaxRate: 0 }).taxRate).toBe(0);
    expect(appointmentInvoiceLine(appt, { defaultTaxRate: 21 }).taxRate).toBe(21);
    expect(appointmentInvoiceLine(appt, {}).taxRate).toBe(21);
    expect(appointmentInvoiceLine(appt, { defaultTaxRate: "x" }).taxRate).toBe(21);
  });

  it("falls back to a generic description without a service", () => {
    expect(appointmentInvoiceLine({ ...appt, service: null }, {}).description).toBe("Servicio");
  });
});

describe("appointmentInvoiceLines: a visit of several services", () => {
  const row = (id: string, serviceId: string, name: string, price: string, over: any = {}) => ({
    id,
    serviceId,
    professionalId: null,
    scheduledStart: null,
    scheduledEnd: null,
    isParallel: false,
    type: "active",
    status: "pending",
    service: { name, price, duration: 30 },
    ...over,
  });
  const visit = {
    price: new Prisma.Decimal("73.00"),
    serviceId: "svc-colour",
    service: { name: "Color", price: "45" },
    services: [row("r1", "svc-colour", "Color", "45"), row("r2", "svc-cut", "Corte", "20")],
    addons: [{ quantity: 2, service: { id: "svc-mask", name: "Mascarilla", price: "4" } }],
  };

  it("one line per service and per add-on, adding up to what was charged", () => {
    const lines = appointmentInvoiceLines(visit, { defaultTaxRate: 7 });
    expect(lines.map((l) => [l.description, l.quantity, l.unitPriceCents, l.taxRate, l.serviceId])).toEqual([
      ["Color", 1, 4500, 7, "svc-colour"],
      ["Corte", 1, 2000, 7, "svc-cut"],
      ["Mascarilla", 2, 400, 7, "svc-mask"],
    ]);
    expect(lines.every((l) => l.taxIncluded === false)).toBe(true);
    expect(calc.compute(lines).subtotalCents).toBe(7300);
  });

  it("prices including tax: every line is split, and the visit totals what was charged", () => {
    const lines = appointmentInvoiceLines(visit, { defaultTaxRate: 21, pricesIncludeTax: true });
    expect(lines.map((l) => [l.description, l.quantity, l.unitPriceCents, l.taxIncluded])).toEqual([
      ["Color", 1, 4500, true],
      ["Corte", 1, 2000, true],
      ["Mascarilla", 2, 400, true],
    ]);
    const r = calc.compute(lines);
    expect(r.totalCents).toBe(7300);
    // 45 / 1,21 = 37,19; 20 / 1,21 = 16,53; 8 / 1,21 = 6,61.
    expect(r.subtotalCents).toBe(3719 + 1653 + 661);
    expect(r.subtotalCents + r.taxBreakdown[0].taxCents).toBe(7300);
  });

  it("prices including tax, IGIC 7 %: the add-on line totals its two units", () => {
    const lines = appointmentInvoiceLines(visit, { defaultTaxRate: 7, pricesIncludeTax: true });
    const r = calc.compute(lines);
    expect(r.totalCents).toBe(7300);
    expect(r.lines.find((l) => l.description === "Mascarilla")).toMatchObject({ quantity: 2, totalCents: 800, taxCents: 52 });
  });

  it("the one-line fallback follows the setting too", () => {
    const lines = appointmentInvoiceLines({ ...visit, price: new Prisma.Decimal("70.00") }, { pricesIncludeTax: true });
    expect(lines).toEqual([expect.objectContaining({ unitPriceCents: 7000, taxIncluded: true })]);
    expect(calc.compute(lines).totalCents).toBe(7000);
  });

  it("a cancelled service is not invoiced", () => {
    const lines = appointmentInvoiceLines(
      { ...visit, price: new Prisma.Decimal("53.00"), services: [visit.services[0], row("r2", "svc-cut", "Corte", "20", { status: "cancelled" })] },
      {},
    );
    expect(lines.map((l) => l.description)).toEqual(["Color", "Mascarilla"]);
  });

  it("when the catalog changed since: one line at the price charged, naming the services", () => {
    const lines = appointmentInvoiceLines({ ...visit, price: new Prisma.Decimal("70.00") }, {});
    expect(lines).toEqual([
      expect.objectContaining({ description: "Color + Corte + Mascarilla", quantity: 1, unitPriceCents: 7000 }),
    ]);
  });

  it("a single service stays the one line it was", () => {
    expect(appointmentInvoiceLines(appt, {})).toEqual([appointmentInvoiceLine(appt, {})]);
  });
});
