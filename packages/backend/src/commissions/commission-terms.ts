import { numberOrNull } from "./commission-rate";
import { pricesIncludeTaxOf, salonTaxRate } from "../invoices/salon-tax-settings";
import { includedTaxCents } from "../pos/pos-ticket";

/**
 * The salon's commission terms (Ajustes > Comisiones, GET/PATCH
 * /commissions/settings), read once per request:
 *
 *   - `defaultRate`: "Comisión por defecto", the rate a service earns when
 *     neither the appointment nor the professional sets one. New salons 0 %;
 *     salons that existed before the setting 10 % (the rate that used to be
 *     hard-coded), set by migration 20261103050000_commissions_phase2;
 *   - `productDefaultRate`: the rate a product sold at the till earns when
 *     the professional who sold it has no "Comisión de productos". 0 %;
 *   - `base`: "Comisión sobre" the price without the tax ("net", the
 *     default) or with it ("gross"), the same for visits and till lines.
 *
 * Bases, in whole cents:
 *   - a visit's `totalAmount` is a catalogue figure: the price with the tax
 *     when the salon's prices include it, without it otherwise
 *     (payments/appointment-charge.ts). catalogueCommissionBase turns it into
 *     the base asked for, at the salon's rate;
 *   - a till line's amount is money, tax included (pos.service.ts):
 *     moneyCommissionBase takes the tax out for "net", at the line's rate.
 */

export type CommissionBase = "net" | "gross";

export interface CommissionTerms {
  defaultRate: number;
  productDefaultRate: number;
  base: CommissionBase;
  /** Whether the catalogue prices include the tax, and the salon's rate (percent). */
  pricesIncludeTax: boolean;
  taxRatePercent: number;
}

/** What commissionTermsOf reads of the salon. */
export const COMMISSION_TERMS_SELECT = {
  commissionDefaultRate: true,
  productCommissionDefaultRate: true,
  commissionBase: true,
  fiscalSettings: true,
} as const;

export function commissionBaseOf(value: unknown): CommissionBase {
  return value === "gross" ? "gross" : "net";
}

/** The terms from a tenant row (any field missing: 0 %, net). */
export function commissionTermsFromTenant(tenant: any): CommissionTerms {
  const fiscal = tenant?.fiscalSettings ?? {};
  return {
    defaultRate: numberOrNull(tenant?.commissionDefaultRate) ?? 0,
    productDefaultRate: numberOrNull(tenant?.productCommissionDefaultRate) ?? 0,
    base: commissionBaseOf(tenant?.commissionBase),
    pricesIncludeTax: pricesIncludeTaxOf(fiscal),
    taxRatePercent: salonTaxRate(fiscal),
  };
}

/** The salon's terms, read from the database (or a transaction on it). */
export async function commissionTermsOf(db: any, tenantId: string): Promise<CommissionTerms> {
  const tenant = db?.tenant?.findUnique
    ? await db.tenant.findUnique({ where: { id: tenantId }, select: COMMISSION_TERMS_SELECT })
    : null;
  return commissionTermsFromTenant(tenant);
}

const positiveRate = (rate: number) => (Number.isFinite(rate) && rate > 0 ? rate : 0);

/** A catalogue amount (a visit's totalAmount, cents) as the commission base. */
export function catalogueCommissionBase(cents: number, terms: CommissionTerms): number {
  const amount = Number(cents);
  if (!Number.isFinite(amount)) return 0;
  const rate = positiveRate(terms.taxRatePercent);
  if (terms.pricesIncludeTax) return terms.base === "gross" ? amount : amount - includedTaxCents(amount, rate);
  return terms.base === "gross" ? amount + Math.round((amount * rate) / 100) : amount;
}

/** A money amount, tax included (a till line, cents), as the commission base. */
export function moneyCommissionBase(cents: number, taxRatePercent: number, base: CommissionBase): number {
  const amount = Number(cents);
  if (!Number.isFinite(amount)) return 0;
  return base === "gross" ? amount : amount - includedTaxCents(amount, positiveRate(taxRatePercent));
}
