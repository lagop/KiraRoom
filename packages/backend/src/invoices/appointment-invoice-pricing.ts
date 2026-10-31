import type { InvoiceLineInput } from "./invoice-calculator.service";
import { VisitRow, visitLines } from "../appointments/visit-totals";

/**
 * The prices a salon sets on its services and products are final prices:
 * what the client pays, tax (IVA, or IGIC / IPSI) included. The owner's
 * decision (31 Oct 2026), in line with Spanish consumer law. An invoice
 * still has to show the base and the tax, so it splits the price instead of
 * adding tax on top: a 30,00 EUR service is invoiced as 24,79 + 5,21 IVA =
 * 30,00 EUR (before, 30,00 + 6,30 = 36,30, more than the price shown).
 */
export const SALON_PRICES_INCLUDE_TAX = true;

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
