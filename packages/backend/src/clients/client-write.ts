import { BadRequestException, ConflictException } from "@nestjs/common";
import { ClientStatus, Gender, NifType, Prisma } from "@prisma/client";
import { validateNif } from "../common/validation/nif.validator";

/**
 * Turning a panel form into a Client write, shared by /clients and
 * /admin/clients so the two paths store the same thing.
 *
 * - An optional field sent as null (or "") is emptied; left out, untouched.
 * - The tax id is checked as a NIF/CIF/NIE unless its type is a passport
 *   or "other" document.
 */
export interface ClientWriteFields {
  firstName?: string;
  lastName?: string;
  email?: string | null;
  phone?: string | null;
  dateOfBirth?: string | Date | null;
  gender?: Gender | null;
  profileImage?: string | null;
  notes?: string | null;
  status?: ClientStatus;
  preferredLanguage?: string;
  preferredServices?: string[];
  preferredProfessionals?: string[];
  preferredTimes?: string[];
  communicationPreferences?: Record<string, any>;
  allergies?: string[];
  medicalConditions?: string[];
  tags?: string[];
  taxId?: string | null;
  taxIdType?: NifType | null;
}

export const CLIENT_EMAIL_TAKEN = "Ese email ya está en uso en este salón";

/** P2002 on Client is @@unique([tenantId, email]): say so, as a 409. */
export function rethrowClientWriteError(error: unknown): never {
  if ((error as { code?: string } | null)?.code === "P2002") {
    throw new ConflictException(CLIENT_EMAIL_TAKEN);
  }
  throw error;
}

/** Document types the NIF checksum does not apply to. */
const FREE_FORM_TAX_ID_TYPES: ReadonlySet<string> = new Set([NifType.passport, NifType.other]);

/**
 * A client's tax id as it should be stored: NIF / CIF / NIE are checked
 * (the AEAT rejects malformed ones on an invoice) and normalized; a
 * passport or "other" document is stored as typed, trimmed and uppercased.
 * Empty means none (null); undefined means "not sent".
 */
export function normalizeClientTaxId(
  taxId: string | null | undefined,
  taxIdType: string | null | undefined,
): string | null | undefined {
  if (taxId === undefined) return undefined;
  if (taxId === null) return null;
  const trimmed = taxId.trim();
  if (!trimmed) return null;
  if (taxIdType && FREE_FORM_TAX_ID_TYPES.has(taxIdType)) {
    return trimmed.toUpperCase();
  }
  const v = validateNif(trimmed);
  if (!v.valid) {
    throw new BadRequestException(
      `El NIF/CIF/NIE no es válido (${v.error}). Si es un pasaporte u otro documento, elige ese tipo.`,
    );
  }
  return v.normalized ?? trimmed;
}

/** Optional text: undefined untouched, null / blank emptied, else trimmed. */
function optionalText(v: string | null | undefined): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

function optionalDate(v: string | Date | null | undefined): Date | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  return new Date(v);
}

function optionalEnum<T>(v: T | null | undefined | ""): T | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  return v;
}

/** The fields every write shares, already emptied / trimmed. */
function commonFields(dto: ClientWriteFields) {
  return {
    firstName: dto.firstName?.trim(),
    lastName: dto.lastName?.trim(),
    email: optionalText(dto.email),
    phone: optionalText(dto.phone),
    dateOfBirth: optionalDate(dto.dateOfBirth),
    gender: optionalEnum(dto.gender),
    profileImage: optionalText(dto.profileImage),
    notes: optionalText(dto.notes),
    status: dto.status,
    preferredLanguage: dto.preferredLanguage,
    preferredServices: dto.preferredServices,
    preferredProfessionals: dto.preferredProfessionals,
    preferredTimes: dto.preferredTimes,
    communicationPreferences: dto.communicationPreferences,
    allergies: dto.allergies,
    medicalConditions: dto.medicalConditions,
    tags: dto.tags,
  };
}

/** Prisma rejects explicit undefined for nothing, but keep the payload tidy. */
function withoutUndefined<T extends Record<string, unknown>>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}

export function buildClientCreateData(
  tenantId: string,
  dto: ClientWriteFields,
): Prisma.ClientUncheckedCreateInput {
  const taxIdType = optionalEnum(dto.taxIdType);
  const fields = commonFields(dto);
  if (!fields.firstName || !fields.lastName) {
    throw new BadRequestException("El nombre y los apellidos son obligatorios");
  }
  return withoutUndefined({
    ...fields,
    firstName: fields.firstName,
    lastName: fields.lastName,
    tenantId,
    status: dto.status ?? ClientStatus.active,
    taxId: normalizeClientTaxId(dto.taxId, taxIdType),
    taxIdType,
  }) as Prisma.ClientUncheckedCreateInput;
}

/**
 * An update. `current` is the stored tax id and type: changing only the
 * type (e.g. passport → NIF) re-checks the id already on file.
 */
export function buildClientUpdateData(
  dto: ClientWriteFields,
  current: { taxId: string | null; taxIdType: NifType | null },
): Prisma.ClientUncheckedUpdateInput {
  const taxIdType = optionalEnum(dto.taxIdType);
  const effectiveType = taxIdType !== undefined ? taxIdType : current.taxIdType;
  let taxId: string | null | undefined;
  if (dto.taxId !== undefined) {
    taxId = normalizeClientTaxId(dto.taxId, effectiveType);
  } else if (taxIdType !== undefined && current.taxId) {
    taxId = normalizeClientTaxId(current.taxId, effectiveType);
  }
  return withoutUndefined({ ...commonFields(dto), taxId, taxIdType }) as Prisma.ClientUncheckedUpdateInput;
}
