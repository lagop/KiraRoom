import { taxLabelOf } from "@kira/shared";
import { pricesIncludeTaxOf, salonTaxRate } from "../invoices/salon-tax-settings";

/**
 * The price a client sees: always the final one, tax included.
 *
 * Spanish consumer law requires the prices shown to consumers to include
 * taxes, and the salon owner decided clients always see what they will pay.
 * A salon whose catalogue is written with the tax inside
 * (`fiscalSettings.pricesIncludeTax` true, every new salon) already stores
 * that price. One whose catalogue is the taxable base (false, or no key: a
 * salon from before the setting) is invoiced base + tax, so its website said
 * 30,00 EUR and the invoice 36,30 EUR. Every place a client reads a price --
 * the public page, the widget, GET /services for anyone outside the salon,
 * the virtual receptionist -- goes through here instead.
 *
 * Same arithmetic as the invoice line (invoices/invoice-calculator.service.ts,
 * tax on top): cents = round(price * 100), tax = round(cents * rate), so the
 * figure shown is exactly what the invoice of that service comes to. Same
 * rate too (salon-tax-settings.ts salonTaxRate: the salon's defaultTaxRate,
 * IGIC 7 in the Canaries, else 21).
 *
 * Only for showing. What is booked and charged is still computed from the
 * catalogue price (Appointment.price is the catalogue figure, invoiced with
 * the salon's setting): never feed a public price back into a booking.
 */
export interface PublicPriceSettings {
  /** The catalogue already holds the final price. */
  pricesIncludeTax: boolean;
  /** Percent, as invoice lines carry it (21, 7, 9.5...). */
  ratePercent: number;
  /** IVA, IGIC or IPSI: the tax the shown prices include. */
  taxLabel: string;
}

/** What publicPrice needs, read from a salon's `Tenant.fiscalSettings`. */
export function publicPriceSettings(fiscalSettings: unknown): PublicPriceSettings {
  return {
    pricesIncludeTax: pricesIncludeTaxOf(fiscalSettings),
    ratePercent: salonTaxRate(fiscalSettings),
    taxLabel: taxLabelOf(fiscalSettings),
  };
}

/**
 * A catalogue price (euros: a Prisma Decimal, a number or a numeric string)
 * as the client pays it, in euros with two decimals. Not a number: 0.
 */
export function publicPrice(
  price: unknown,
  settings: Pick<PublicPriceSettings, "pricesIncludeTax" | "ratePercent">,
): number {
  const n = Number(price);
  if (!Number.isFinite(n)) return 0;
  const cents = Math.round(n * 100);
  if (settings.pricesIncludeTax) return cents / 100;
  const rate = Number.isFinite(settings.ratePercent) && settings.ratePercent > 0 ? settings.ratePercent : 0;
  const tax = Math.round(cents * (rate / 100));
  return (cents + tax) / 100;
}

/** "IVA incluido", "IGIC incluido", "IPSI incluido". */
export function taxIncludedNote(settings: Pick<PublicPriceSettings, "taxLabel">): string {
  return `${settings.taxLabel} incluido`;
}
