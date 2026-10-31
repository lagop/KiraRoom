import type { InvoiceLineInput } from "./invoice-calculator.service";

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
 *     amounts are integer cents). `Appointment.totalAmount` is in cents and
 *     today always equals price * 100: neither the extra services of a
 *     multi-service visit nor add-ons are added to it anywhere, so there is
 *     no real visit total to use yet. When there is, use it here (it is
 *     already cents: do not multiply it by 100 again).
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
