/**
 * How a salon's prices meet its invoices: which tax rate it charges and
 * whether the prices it sets on its services and products already include
 * that tax. Both live in the salon's own `Tenant.fiscalSettings`, edited in
 * Ajustes fiscales (/dashboard/settings/fiscal): a salon in the peninsula
 * charges IVA, one in the Canaries IGIC, one in Ceuta or Melilla IPSI, and
 * each one decides how its price list is written.
 *
 *   pricesIncludeTax true: the price is what the client pays. A 30,00 EUR
 *     service is invoiced as 24,79 + 5,21 IVA = 30,00 EUR.
 *   pricesIncludeTax false: the price is the taxable base and the tax is
 *     added on top: 30,00 + 6,30 IVA = 36,30 EUR.
 *
 * A salon created before the setting existed has no key: that reads as
 * false, what KiraRoom always did, so none of its invoices change without
 * the salon choosing it. A new salon starts with true
 * (NEW_SALON_FISCAL_SETTINGS), in line with Spanish consumer law, which
 * requires the prices shown to consumers to include taxes.
 */

import { TAX_REGIME_DEFAULT_RATE, taxRegimeOf } from "@kira/shared";

/** IVA general rate: the fallback of a salon with no defaultTaxRate and no regime. */
export const FALLBACK_TAX_RATE = TAX_REGIME_DEFAULT_RATE.iva;

/**
 * The fiscal settings a salon is created with: the column default
 * (schema.prisma, Tenant.fiscalSettings) plus pricesIncludeTax. Set
 * explicitly at tenant creation (saas.helpers.ts createTenantWithOwner)
 * rather than by changing the column default, so existing rows are never
 * touched.
 */
export const NEW_SALON_FISCAL_SETTINGS = {
  defaultSeries: "A",
  defaultTaxRate: 21,
  autoInvoiceAppointments: false,
  diputacion: null,
  taxRegime: "iva",
  pricesIncludeTax: true,
} as const;

/** Whether the salon's prices include the tax. Missing or not a boolean: false. */
export function pricesIncludeTaxOf(fiscalSettings: unknown): boolean {
  return (fiscalSettings as { pricesIncludeTax?: unknown } | null)?.pricesIncludeTax === true;
}

/**
 * The salon's `fiscalSettings.defaultTaxRate`. None set: its regime's
 * general rate (IVA 21, IGIC 7, IPSI 10), what the panel's invoice form
 * offers too. It used to be 21 whatever the regime, so a Canarian salon with
 * no explicit rate had its appointments invoiced at 21 % "IGIC".
 */
export function salonTaxRate(fiscalSettings: unknown): number {
  const rate = (fiscalSettings as { defaultTaxRate?: unknown } | null)?.defaultTaxRate;
  if (typeof rate === "number" && Number.isFinite(rate) && rate >= 0) return rate;
  return TAX_REGIME_DEFAULT_RATE[taxRegimeOf(fiscalSettings)];
}

/**
 * A product's own rate, as an invoice line's percent. `Product.taxRate` is a
 * fraction (0.21 for 21 %, the product DTO caps it at 1); invoice lines and
 * the salon's defaultTaxRate are percents (21). A value above 1 can only be a
 * percent already, and is kept. No rate of its own: the salon's.
 */
export function productTaxRatePercent(raw: unknown, salonRate: number): number {
  if (raw === null || raw === undefined) return salonRate;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return salonRate;
  return n > 1 ? n : Math.round(n * 10000) / 100;
}
