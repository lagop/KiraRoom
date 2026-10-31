import { Prisma } from "@prisma/client";
import { appointmentInvoiceLine, SALON_PRICES_INCLUDE_TAX } from "./appointment-invoice-pricing";
import { InvoiceCalculator } from "./invoice-calculator.service";

const calc = new InvoiceCalculator();
const appt = { price: new Prisma.Decimal("30.00"), serviceId: "svc-1", service: { name: "Corte" } };

describe("appointmentInvoiceLine", () => {
  it("keeps today's default: tax added on top of the price", () => {
    expect(SALON_PRICES_INCLUDE_TAX).toBe(false);
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
