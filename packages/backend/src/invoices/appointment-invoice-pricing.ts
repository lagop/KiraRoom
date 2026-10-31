import type { InvoiceLineInput } from "./invoice-calculator.service";
import { VisitRow, visitLines } from "../appointments/visit-totals";

/**
 * Do the prices a salon sets on its services already include the tax
 * (IVA, or IGIC / IPSI)? OPEN DECISION FOR THE OWNER: this constant is the
 * one line to change. There is no per-salon setting for it yet.
 *
 *   false (what KiraRoom has always done): the service price is the taxable
 *     base and the tax is added on top. A 30,00 EUR service is invoiced as
 *     30,00 + 6,30 IVA = 36,30 EUR, more than the price the client was shown.
 *   true: the price is what the client pays, tax included. The same service
 *     is invoiced as 24,79 + 5,21 IVA = 30,00 EUR.
 *
 * Spanish consumer law requires prices shown to consumers to include taxes,
 * which points to true for a salon's public prices; but changing it lowers
 * every future automatic invoice's base, so it is not flipped silently.
 */
export const SALON_PRICES_INCLUDE_TAX = false;

/** IVA general rate, used when the salon set no defaultTaxRate. */
const FALLBACK_TAX_RATE = 21;

export interface AppointmentToInvoice {
  /** Appointment.price: Decimal, in EUROS (not cents). */
  price: unknown;
  serviceId: string;
  service?: { name: string } | null;
}

/**
 * The invoice line for a completed appointment. Every pricing decision of the
 * automatic appointment invoice is made here:
 *
 *   - Amount: `Appointment.price`, in euros, converted to cents (Invoice
 *     amounts are integer cents). It is the whole visit: every service of a
 *     multi-service visit plus its add-ons (visit-totals.ts), kept equal to
 *     `Appointment.totalAmount`, which is already cents (never x100 again).
 *     One line per service: appointmentInvoiceLines, below.
 *   - Rate: the salon's `fiscalSettings.defaultTaxRate` (7 for an IGIC salon,
 *     for instance), else 21, the same rule POS order invoices follow.
 *   - Tax included or on top: `pricesIncludeTax`, see SALON_PRICES_INCLUDE_TAX.
 */
export function appointmentInvoiceLine(
  appointment: AppointmentToInvoice,
  fiscalSettings: Record<string, unknown>,
  pricesIncludeTax: boolean = SALON_PRICES_INCLUDE_TAX,
): InvoiceLineInput {
  return {
    description: appointment.service?.name ?? "Servicio",
    quantity: 1,
    unitPriceCents: Math.round(Number(appointment.price) * 100),
    taxRate: salonTaxRate(fiscalSettings),
    taxIncluded: pricesIncludeTax,
    serviceId: appointment.serviceId,
  };
}

function salonTaxRate(fiscalSettings: Record<string, unknown>): number {
  const rate = fiscalSettings.defaultTaxRate;
  return typeof rate === "number" && Number.isFinite(rate) && rate >= 0 ? rate : FALLBACK_TAX_RATE;
}

export interface VisitToInvoice extends AppointmentToInvoice {
  service?: { name: string; price?: unknown } | null;
  /** The visit's service rows, with their services (appointment_services). */
  services?: Array<VisitRow & { service?: { name?: string | null; price?: unknown; duration?: number | null } | null }>;
  /** Its add-ons, resolved to the catalog services they are (visit-sync.ts's addonServices). */
  addons?: Array<{ quantity: number; service: { id?: string; name?: string | null; price?: unknown } | null }>;
}

/**
 * The invoice lines for a completed visit: one per service and one per
 * add-on (with its quantity), from visit-totals.ts's visitLines, when they
 * add up to the visit's price -- the figure the client was charged
 * (`Appointment.price`, euros, the whole visit since multi-service totals
 * were fixed).
 *
 * When they do not (a catalog price changed after the booking, an imported
 * price), the invoice must still say what was charged: one line at the
 * visit's price, naming its services.
 */
export function appointmentInvoiceLines(
  appointment: VisitToInvoice,
  fiscalSettings: Record<string, unknown>,
  pricesIncludeTax: boolean = SALON_PRICES_INCLUDE_TAX,
): InvoiceLineInput[] {
  const tax = { taxRate: salonTaxRate(fiscalSettings), taxIncluded: pricesIncludeTax };
  const charged = Math.round(Number(appointment.price) * 100);
  const lines = visitLines({
    mainService: { id: appointment.serviceId, name: appointment.service?.name, price: appointment.service?.price },
    rows: appointment.services ?? [],
    addons: appointment.addons ?? [],
  });
  const sum = lines.reduce((total, l) => total + l.unitPriceCents * l.quantity, 0);
  if (lines.length > 1 && sum === charged) {
    return lines.map((l) => ({ ...l, ...tax }));
  }
  const names = [...new Set(lines.map((l) => l.description))];
  return [
    {
      ...appointmentInvoiceLine(appointment, fiscalSettings, pricesIncludeTax),
      ...(names.length > 1 ? { description: names.join(" + ") } : {}),
    },
  ];
}
