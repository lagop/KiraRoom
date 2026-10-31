import type { InvoiceLineInput } from "./invoice-calculator.service";
import { VisitRow, visitLines } from "../appointments/visit-totals";
import { pricesIncludeTaxOf, salonTaxRate } from "./salon-tax-settings";

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
 *   - Tax included or on top: the salon's `fiscalSettings.pricesIncludeTax`
 *     (salon-tax-settings.ts). Missing: on top, as before the setting.
 */
export function appointmentInvoiceLine(
  appointment: AppointmentToInvoice,
  fiscalSettings: Record<string, unknown>,
): InvoiceLineInput {
  return {
    description: appointment.service?.name ?? "Servicio",
    quantity: 1,
    unitPriceCents: Math.round(Number(appointment.price) * 100),
    taxRate: salonTaxRate(fiscalSettings),
    taxIncluded: pricesIncludeTaxOf(fiscalSettings),
    serviceId: appointment.serviceId,
  };
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
): InvoiceLineInput[] {
  const tax = { taxRate: salonTaxRate(fiscalSettings), taxIncluded: pricesIncludeTaxOf(fiscalSettings) };
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
      ...appointmentInvoiceLine(appointment, fiscalSettings),
      ...(names.length > 1 ? { description: names.join(" + ") } : {}),
    },
  ];
}
