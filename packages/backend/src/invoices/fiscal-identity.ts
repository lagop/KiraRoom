import { BadRequestException } from "@nestjs/common";
import type { NifType } from "@prisma/client";
import { validateNif } from "../common/validation/nif.validator";

/**
 * The salon's identity as an invoice issuer: NIF, its type and the razón
 * social. They live in the Tenant columns taxId / taxIdType / legalName,
 * which is what an issued invoice copies (invoices.service.ts prepare) and
 * what the settings page shows. fiscalSettings.tenantNif is a mirror of
 * taxId kept for the VERI*FACTU / TicketBAI submission code, which reads it
 * from the settings JSON; it is only the source for a salon whose column is
 * still empty.
 */

export const FISCAL_SETTINGS_SELECT = {
  fiscalMode: true,
  fiscalSettings: true,
  taxId: true,
  taxIdType: true,
  legalName: true,
} as const;

export interface FiscalSettingsRow {
  fiscalMode: string;
  fiscalSettings: unknown;
  taxId: string | null;
  taxIdType: NifType | null;
  legalName: string | null;
}

/** What GET and PATCH /invoices/settings/fiscal answer. */
export function fiscalSettingsView(tenant: FiscalSettingsRow | null) {
  const settings = (tenant?.fiscalSettings as Record<string, unknown> | null) ?? {};
  const mirrored = typeof settings.tenantNif === "string" && settings.tenantNif.trim() ? settings.tenantNif : null;
  return {
    fiscalMode: tenant?.fiscalMode ?? "none",
    fiscalSettings: settings,
    taxId: tenant?.taxId || mirrored,
    taxIdType: tenant?.taxIdType ?? null,
    legalName: tenant?.legalName ?? null,
  };
}

export const LEGAL_NAME_REQUIRED =
  "La razón social no puede quedar vacía: es obligatoria en las facturas. Escribe la razón social del salón.";
export const TAX_ID_REQUIRED =
  "El NIF no puede quedar vacío: es obligatorio en las facturas. Escribe el NIF, CIF o NIE del salón.";

/** Why validateNif refused it, in the words the owner reads. */
const TAX_ID_ERRORS: Record<string, string> = {
  length: "tiene que tener 9 caracteres",
  format:
    "no tiene la forma de un NIF (8 números y una letra), de un NIE (X, Y o Z, 7 números y una letra) ni de un CIF (una letra, 7 números y un control)",
  "nif-checksum": "la letra no corresponde a los números",
  "nie-checksum": "la letra no corresponde a los números",
  "cif-checksum": "el carácter de control no corresponde a los números",
  "cif-control-type": "el carácter de control no es del tipo que lleva esa letra inicial",
};

export function taxIdInvalidMessage(error: string | undefined): string {
  const why = (error && TAX_ID_ERRORS[error]) || "no es válido";
  return `El NIF/CIF/NIE del salón no es válido: ${why}. Revísalo: sale en todas tus facturas y Hacienda rechaza las que llevan un NIF erróneo.`;
}

/**
 * Normalises the default invoice series: trimmed and in capitals, so "a"
 * and "A" are one numbering sequence and not two. Up to four letters or
 * digits; an empty series is refused (invoices with no series).
 */
export const SERIES_FORMAT = /^[A-Z0-9]{1,4}$/;
export const SERIES_INVALID =
  "La serie tiene que tener de 1 a 4 letras o números, sin espacios ni símbolos (por ejemplo A o 2026).";

export function normalizeSeries(value: string): string {
  const series = value.trim().toUpperCase();
  if (!SERIES_FORMAT.test(series)) throw new BadRequestException(SERIES_INVALID);
  return series;
}

/**
 * The identity fields a PATCH changes. A field that is not sent is left as
 * it is. One that is sent empty (or null) is refused: the razón social and
 * the NIF are mandatory on an invoice (arts. 6-7 RD 1619/2012), and an
 * empty value is what a form that never loaded them sends.
 */
export function issuerIdentityPatch(dto: {
  tenantNif?: unknown;
  taxIdType?: unknown;
  legalName?: unknown;
}): { taxId?: string; taxIdType?: NifType; legalName?: string } {
  const out: { taxId?: string; taxIdType?: NifType; legalName?: string } = {};
  if (dto.legalName !== undefined) {
    if (typeof dto.legalName !== "string" || !dto.legalName.trim()) {
      throw new BadRequestException(LEGAL_NAME_REQUIRED);
    }
    out.legalName = dto.legalName.trim();
  }
  // null (or anything that is not a type) leaves the stored type alone; the
  // DTO already refuses values outside the enum.
  if (typeof dto.taxIdType === "string") {
    out.taxIdType = dto.taxIdType as NifType;
  }
  if (dto.tenantNif !== undefined) {
    if (typeof dto.tenantNif !== "string" || !dto.tenantNif.trim()) {
      throw new BadRequestException(TAX_ID_REQUIRED);
    }
    // The issuer of a Spanish invoice has a Spanish NIF, so it is checked as
    // the SaaS admin's edit checks it (saas.service.ts updateTenant) and is
    // stored normalised (no spaces, dots or dashes). Its type is the one the
    // number itself is: a CIF saved under "NIF" is what the select left.
    const v = validateNif(dto.tenantNif);
    if (!v.valid || !v.normalized || !v.type) {
      throw new BadRequestException(taxIdInvalidMessage(v.error));
    }
    out.taxId = v.normalized;
    out.taxIdType = v.type as NifType;
  }
  return out;
}
