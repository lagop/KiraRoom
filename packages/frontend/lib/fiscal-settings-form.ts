/**
 * Ajustes > Fiscal: how the saved settings fill the issuer fields, and what a
 * save sends.
 *
 * The page used to read the razón social and the ID type from a response that
 * did not carry them, so they loaded empty and every save wrote them back
 * empty. Now it loads them from GET /invoices/settings/fiscal and a save sends
 * only the fields the user changed: a field nobody touched is never sent, so
 * it cannot overwrite what is stored.
 *
 * No React and no Next imports, so lib/fiscal-settings-form.spec.ts can run
 * them.
 */
import type { FiscalSettings, ZeroRateTreatment } from "./api";

export type TaxIdType = "nif" | "cif" | "nie" | "passport" | "other";

const TAX_ID_TYPES: readonly TaxIdType[] = ["nif", "cif", "nie", "passport", "other"];

/** NIF, its type and razón social, as the form shows them. */
export function issuerFieldsFromSettings(data: Pick<FiscalSettings, "fiscalSettings" | "taxId" | "taxIdType" | "legalName">): {
  tenantNif: string;
  taxIdType: TaxIdType;
  legalName: string;
} {
  const mirrored = data.fiscalSettings?.tenantNif;
  const taxIdType = data.taxIdType && TAX_ID_TYPES.includes(data.taxIdType) ? data.taxIdType : "nif";
  return {
    // The Tenant column is the source; the settings mirror only for a salon
    // whose column is still empty.
    tenantNif: data.taxId || (typeof mirrored === "string" ? mirrored : "") || "",
    taxIdType,
    legalName: data.legalName ?? "",
  };
}

/** The fields of `draft` that differ from what was loaded. */
export function changedFiscalFields<T extends Record<string, unknown>>(draft: T, loaded: T): Partial<T> {
  const patch: Partial<T> = {};
  for (const key of Object.keys(draft) as Array<keyof T>) {
    if (draft[key] !== loaded[key]) patch[key] = draft[key];
  }
  return patch;
}

/** The choices for the 0 %, in the order the page lists them. */
export const ZERO_RATE_TREATMENTS: readonly ZeroRateTreatment[] = ["none", "S1", "E1", "E2", "E3", "E4", "E5", "E6", "N1", "N2"];

/** The salon's stored choice, if it has made one. */
export function zeroRateTreatmentFrom(settings: { zeroRateTreatment?: unknown } | null | undefined): ZeroRateTreatment | undefined {
  const value = settings?.zeroRateTreatment;
  return ZERO_RATE_TREATMENTS.find((t) => t === value);
}

/** Verifactu chosen with no answer for the 0 %: the backend would refuse the save. */
export function zeroRateMissing(draft: { fiscalMode?: string; zeroRateTreatment?: ZeroRateTreatment }): boolean {
  return draft.fiscalMode === "verifactu" && !draft.zeroRateTreatment;
}

/**
 * refetchInterval of the VERI*FACTU status: every `ms` while the salon has
 * it active, nothing otherwise (the first answer says which).
 */
export function pollWhileActive(ms: number) {
  return (query: { state: { data?: { active?: boolean } } }): number | false => (query.state.data?.active ? ms : false);
}

/** The settings a change of which is confirmed before saving. */
export interface FiscalRiskFields {
  tenantNif: string;
  defaultSeries: string;
  defaultTaxRate: number;
  taxRegime: "iva" | "igic" | "ipsi";
  pricesIncludeTax: boolean;
  /** Left out by callers that do not change it. */
  fiscalMode?: string;
}

const TAX_LABEL: Record<FiscalRiskFields["taxRegime"], string> = { iva: "IVA", igic: "IGIC", ipsi: "IPSI" };

/** "30,00 €" for 3000 cents; same as prices-tax-example formatEuros. */
function euros(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  const whole = Math.floor(abs / 100)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${cents < 0 ? "-" : ""}${whole},${String(abs % 100).padStart(2, "0")} €`;
}

/** What a 30,00 € catalogue price costs the client under these settings. */
function clientTotal(rate: number, included: boolean): number {
  if (included) return 3000;
  const r = Number.isFinite(rate) && rate > 0 ? rate : 0;
  return 3000 + Math.round(3000 * (r / 100));
}

/**
 * The lines of the confirmation shown before saving a change to the NIF, the
 * default series, the tax regime or whether prices include the tax: what
 * changes for the invoices from now on (the ones already issued keep their
 * values, said by the dialog's intro). Empty when none of those changed, so
 * a save of anything else goes through without a dialog.
 */
export function fiscalChangeSummary(
  draft: FiscalRiskFields,
  loaded: FiscalRiskFields,
): Array<{ key: string; params: Record<string, string> }> {
  const lines: Array<{ key: string; params: Record<string, string> }> = [];
  if (draft.fiscalMode === "verifactu" && loaded.fiscalMode !== "verifactu") {
    lines.push({ key: "invoices.fiscalSettings.confirmVerifactu", params: {} });
  }
  if (draft.tenantNif.trim().toUpperCase() !== loaded.tenantNif.trim().toUpperCase()) {
    lines.push({ key: "invoices.fiscalSettings.confirmTaxId", params: { taxId: draft.tenantNif.trim().toUpperCase() } });
  }
  if (draft.defaultSeries.trim().toUpperCase() !== loaded.defaultSeries.trim().toUpperCase()) {
    lines.push({
      key: "invoices.fiscalSettings.confirmSeries",
      params: { series: draft.defaultSeries.trim().toUpperCase() },
    });
  }
  const regimeChanged = draft.taxRegime !== loaded.taxRegime;
  if (regimeChanged) {
    lines.push({
      key: "invoices.fiscalSettings.confirmRegime",
      params: {
        tax: TAX_LABEL[draft.taxRegime],
        previous: TAX_LABEL[loaded.taxRegime],
        rate: String(draft.defaultTaxRate).replace(".", ","),
      },
    });
  }
  if (regimeChanged || draft.pricesIncludeTax !== loaded.pricesIncludeTax) {
    const before = clientTotal(loaded.defaultTaxRate, loaded.pricesIncludeTax);
    const after = clientTotal(draft.defaultTaxRate, draft.pricesIncludeTax);
    if (before !== after || draft.pricesIncludeTax !== loaded.pricesIncludeTax) {
      lines.push({
        key: "invoices.fiscalSettings.confirmPrices",
        params: { price: euros(3000), before: euros(before), after: euros(after), tax: TAX_LABEL[draft.taxRegime] },
      });
    }
  }
  return lines;
}
