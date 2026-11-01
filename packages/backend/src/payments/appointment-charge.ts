import { InvoiceCalculator } from "../invoices/invoice-calculator.service";
import { appointmentInvoiceLines, type VisitToInvoice } from "../invoices/appointment-invoice-pricing";
import { pricesIncludeTaxOf, salonTaxRate } from "../invoices/salon-tax-settings";
import { appointmentTotalCents } from "./appointment-payment";

/**
 * What a visit costs the client in MONEY: tax included, the figure its
 * invoice comes to. The money basis of the till.
 *
 * The two bases, and why both exist:
 *
 *   - Catalogue basis: `Service.price`, `Product.price`, `Appointment.price`
 *     and `Appointment.totalAmount` are the salon's price list, written with
 *     the tax inside (`fiscalSettings.pricesIncludeTax` true, every new
 *     salon) or as the taxable base (false or missing: older salons). The
 *     invoice is computed from them (appointment-invoice-pricing.ts), and
 *     commissions are a percent of `totalAmount` (catalogue).
 *   - Money basis: what the client hands over. `Payment.amount`,
 *     `Refund.amount`, `Appointment.amountPaid`, deposits, wallet and gift
 *     card movements, loyalty discounts and every amount the till shows.
 *     It is always tax included and equal to the invoice total.
 *
 * For a salon whose prices include the tax both are the same number. For
 * one whose prices are the base, a 30,00 EUR service is 36,30 EUR of money
 * (base + tax, rounded per invoice line exactly as InvoiceCalculator does):
 * the till used to charge 30,00 and the invoice said 36,30.
 *
 * `amountDue` = money total - amountPaid, in money.
 */
export interface SalonTaxBasis {
  pricesIncludeTax: boolean;
  /** The salon's rate, percent (21, 7...). */
  ratePercent: number;
}

export function salonTaxBasis(fiscalSettings: unknown): SalonTaxBasis {
  return { pricesIncludeTax: pricesIncludeTaxOf(fiscalSettings), ratePercent: salonTaxRate(fiscalSettings) };
}

/**
 * A catalogue amount (cents) as money: unchanged when the prices include
 * the tax, else base + round(base x rate) -- one invoice line's arithmetic
 * (InvoiceCalculator, tax on top) and the public price's (public-price.ts).
 */
export function moneyOfCatalogueCents(cents: number, basis: SalonTaxBasis): number {
  if (basis.pricesIncludeTax) return cents;
  const rate = Number.isFinite(basis.ratePercent) && basis.ratePercent > 0 ? basis.ratePercent : 0;
  return cents + Math.round(cents * (rate / 100));
}

const calculator = new InvoiceCalculator();

/** A visit with what its invoice reads (appointment-invoice-pricing.ts). */
export type ChargeableVisit = VisitToInvoice & { totalAmount?: unknown };

/**
 * The money total of a visit as it stands: for a salon whose prices
 * include the tax, its catalogue total (the same number); otherwise what
 * its invoice comes to, computed with the invoice's own lines and rounding.
 */
export function visitChargeCents(visit: ChargeableVisit, fiscalSettings: unknown): number {
  const catalogue = appointmentTotalCents(visit as any);
  if (pricesIncludeTaxOf(fiscalSettings)) return catalogue;
  const settings = (fiscalSettings ?? {}) as Record<string, unknown>;
  const priced = { ...visit, price: Number(visit.price ?? 0) > 0 ? visit.price : catalogue / 100 };
  return calculator.compute(appointmentInvoiceLines(priced, settings)).totalCents;
}

/**
 * A discount of `moneyCents` taken at the till off a visit, in the visit's
 * catalogue terms: the cents its `totalAmount` goes down by (and its invoice
 * shows as the line discount), and the money total it then comes to.
 *
 * With the tax in the prices they are the same. Otherwise the base is cut
 * so the invoice comes as close as cents allow to the money total less the
 * discount: not every money amount is reachable (36,30 EUR is 30,00 + 6,30;
 * base + tax jumps 1 or 2 cents a cent), so the discount actually given can
 * be a cent off what was asked. The till charges what the invoice says.
 */
export function visitDiscountInCatalogue(
  visit: ChargeableVisit,
  fiscalSettings: unknown,
  moneyCents: number,
): { catalogueCents: number; chargeAfterCents: number } {
  const catalogue = appointmentTotalCents(visit as any);
  const before = visitChargeCents(visit, fiscalSettings);
  if (moneyCents <= 0) return { catalogueCents: 0, chargeAfterCents: before };
  if (pricesIncludeTaxOf(fiscalSettings)) {
    const off = Math.min(moneyCents, catalogue);
    return { catalogueCents: off, chargeAfterCents: before - off };
  }
  const rate = salonTaxRate(fiscalSettings);
  const target = before - moneyCents;
  const guess = Math.round((moneyCents * 100) / (100 + rate));
  let best = { catalogueCents: 0, chargeAfterCents: before };
  let bestGap = Infinity;
  for (let off = Math.max(0, guess - 3); off <= Math.min(catalogue, guess + 3); off++) {
    const after = visitChargeCents(
      {
        ...visit,
        price: (catalogue - off) / 100,
        totalAmount: catalogue - off,
        discount: { ...(asObject(visit.discount)), pos: { amountCents: off } },
      },
      fiscalSettings,
    );
    const gap = Math.abs(after - target);
    if (gap < bestGap) {
      best = { catalogueCents: off, chargeAfterCents: after };
      bestGap = gap;
    }
  }
  return best;
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
