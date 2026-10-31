import { Prisma } from "@prisma/client";
import { appointmentInvoiceLine, appointmentInvoiceLines, SALON_PRICES_INCLUDE_TAX } from "./appointment-invoice-pricing";
import { InvoiceCalculator } from "./invoice-calculator.service";

const calc = new InvoiceCalculator();
const appt = { price: new Prisma.Decimal("30.00"), serviceId: "svc-1", service: { name: "Corte" } };

describe("appointmentInvoiceLine", () => {
  it("prices are final: the tax is inside the price, not on top", () => {
    expect(SALON_PRICES_INCLUDE_TAX).toBe(true);
    const line = appointmentInvoiceLine(appt, {});
    expect(line).toEqual({
      description: "Corte",
      quantity: 1,
      unitPriceCents: 3000,
      taxRate: 21,
      taxIncluded: true,
      serviceId: "svc-1",
    });
    const r = calc.compute([line]);
    expect(r.subtotalCents).toBe(2479);
    expect(r.totalCents).toBe(3000);
  });

  it("prices including tax: the invoice total is the price", () => {
    const r = calc.compute([appointmentInvoiceLine(appt, {}, true)]);
    expect(r.totalCents).toBe(3000);
    expect(r.subtotalCents).toBe(2479);
    expect(r.taxBreakdown).toEqual([{ rate: 21, baseCents: 2479, taxCents: 521 }]);
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
    expect(calc.compute(lines).totalCents).toBe(7300);
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
