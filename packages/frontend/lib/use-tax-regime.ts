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
 */
export function useTaxRegime(): {
  regime: TaxRegime;
  label: string;
  defaultRate: number;
  isLoading: boolean;
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
    defaultRate: TAX_REGIME_DEFAULT_RATE[regime],
    isLoading: settings.isLoading,
  };
}
