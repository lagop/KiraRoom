"use client";

import { useQuery } from "@tanstack/react-query";
import apiClient, { FiscalSettings } from "./api";
import {
  taxRegimeOf,
  TAX_REGIME_LABELS,
  TAX_REGIME_DEFAULT_RATE,
  DEFAULT_TAX_REGIME,
  type TaxRegime,
} from "@kira/shared";
import { salonDefaultTaxRate } from "./invoice-totals";

/**
 * The tenant's indirect tax regime, for anything that has to name the tax or
 * pick a default rate.
 *
 * The interface said "IVA" in fixed strings and the invoice form defaulted new
 * lines to 21 %. Both are wrong in the Canary Islands, which uses IGIC at
 * 0/3/7/9.5/15/20, and in Ceuta and Melilla, which use IPSI.
 *
 * Shares the react-query cache key with the fiscal settings screen, so using
 * this hook costs no extra request on any page that already loads them.
 *
 * Falls back to IVA while the request is in flight and if it fails: it is the
 * regime of most of the country, and a label is not worth a loading spinner.
 *
 * `defaultRate` is the salon's own fiscalSettings.defaultTaxRate when it set
 * one, else its regime's default (21 IVA, 7 IGIC, 4 IPSI).
 *
 * `pricesIncludeTax` is the salon's "Mis precios ya incluyen el impuesto"
 * (fiscalSettings.pricesIncludeTax), read the way the server reads it
 * (salon-tax-settings.ts pricesIncludeTaxOf): only the boolean true counts,
 * missing is false. It is `undefined` while the settings are loading or when
 * they could not be loaded: unlike a label, it changes the amounts of an
 * invoice, so a caller that issues one has to wait for it instead of guessing.
 *
 * `serverRate` is the rate the server applies to the salon's catalogue, on
 * appointment invoices and on the prices clients see (backend
 * salon-tax-settings.ts salonTaxRate): defaultTaxRate when set, else 21,
 * whatever the regime. Use it to predict those amounts.
 */
export function useTaxRegime(): {
  regime: TaxRegime;
  label: string;
  defaultRate: number;
  serverRate: number;
  pricesIncludeTax: boolean | undefined;
  isLoading: boolean;
  isError: boolean;
} {
  const settings = useQuery<FiscalSettings>({
    queryKey: ["invoices", "fiscal-settings"],
    queryFn: () => apiClient.getFiscalSettings(),
    staleTime: 5 * 60 * 1000,
  });

  const regime = settings.data
    ? taxRegimeOf(settings.data.fiscalSettings)
    : DEFAULT_TAX_REGIME;

  return {
    regime,
    label: TAX_REGIME_LABELS[regime],
    defaultRate: salonDefaultTaxRate(
      settings.data?.fiscalSettings?.defaultTaxRate,
      TAX_REGIME_DEFAULT_RATE[regime],
    ),
    serverRate: salonDefaultTaxRate(settings.data?.fiscalSettings?.defaultTaxRate, 21),
    pricesIncludeTax: settings.data
      ? settings.data.fiscalSettings?.pricesIncludeTax === true
      : undefined,
    isLoading: settings.isLoading,
    isError: settings.isError,
  };
}
