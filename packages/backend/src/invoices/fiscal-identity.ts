import { BadRequestException } from "@nestjs/common";
import type { NifType } from "@prisma/client";

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
  if (dto.tenantNif !== undefined) {
    if (typeof dto.tenantNif !== "string" || !dto.tenantNif.trim()) {
      throw new BadRequestException(TAX_ID_REQUIRED);
    }
    out.taxId = dto.tenantNif.trim().toUpperCase();
  }
  // null (or anything that is not a type) leaves the stored type alone; the
  // DTO already refuses values outside the enum.
  if (typeof dto.taxIdType === "string") {
    out.taxIdType = dto.taxIdType as NifType;
  }
  return out;
}
