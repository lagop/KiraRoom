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
import type { FiscalSettings } from "./api";

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
