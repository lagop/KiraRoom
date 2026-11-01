import { normalizePhone, phoneKey } from "../common/phone";

/**
 * How a client's email and phone are stored and looked up, so the same
 * person is found again whichever way the salon, the booking form, the till
 * or the import typed her details.
 *
 * - Email: stored trimmed and in lower case. Looked up case-insensitively,
 *   since records saved before 2026-11 may still have capitals (the
 *   migration 20261101110000_client_email_lowercase lowercased every one it
 *   could without making two clients of a salon share an address).
 * - Phone: stored in international form ("+34600111222", the salon's
 *   country for a number without a prefix). Looked up by its last nine
 *   digits, so "600 111 222", "+34 600111222" and "0034600111222" are one.
 */

/** Something that runs Prisma queries: the service or a transaction. */
interface ContactDb {
  tenant: { findUnique(args: any): Promise<{ country: string | null } | null> };
  $queryRaw<T = unknown>(query: TemplateStringsArray, ...values: any[]): Promise<T>;
}

/**
 * An email as stored. undefined: not sent (leave it); null or blank: none;
 * else trimmed and lower-cased.
 */
export function normalizeClientEmail(raw: string | null | undefined): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const value = raw.trim().toLowerCase();
  return value === "" ? null : value;
}

/** A Prisma filter matching this email whatever its case. */
export function clientEmailFilter(email: string): { equals: string; mode: "insensitive" } {
  return { equals: email.trim().toLowerCase(), mode: "insensitive" };
}

/**
 * A phone as stored. undefined: not sent; null or blank: none. A number
 * with at least nine digits goes to international form with the salon's
 * country; anything shorter is kept as typed (trimmed), since it cannot be
 * told apart from a typo.
 */
export function normalizeClientPhone(
  raw: string | null | undefined,
  country: string | null | undefined = "ES",
): string | null | undefined {
  if (raw === undefined) return undefined;
  if (raw === null) return null;
  const value = raw.trim();
  if (value === "") return null;
  return phoneKey(value).length === 9 ? normalizePhone(value, country || "ES") : value;
}

/** The salon's country, for the phone prefix ("ES" when unknown). */
export async function salonCountry(db: ContactDb, tenantId: string): Promise<string> {
  const tenant = await db.tenant.findUnique({ where: { id: tenantId }, select: { country: true } });
  return tenant?.country || "ES";
}

/** The salon's country when a phone is being written; no query otherwise. */
export async function countryForPhone(
  db: ContactDb,
  tenantId: string,
  phone: string | null | undefined,
): Promise<string> {
  return phone && phone.trim() ? salonCountry(db, tenantId) : "ES";
}

/**
 * The salon's oldest client whose phone ends in the same nine digits, or
 * null. Stored numbers are in whatever format they were typed in the past,
 * so the comparison is on digits, in SQL.
 */
export async function findClientIdByPhone(
  db: ContactDb,
  tenantId: string,
  phone: string | null | undefined,
): Promise<string | null> {
  const key = phoneKey(phone);
  if (key.length !== 9) return null;
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM clients
    WHERE "tenantId" = ${tenantId}
      AND right(regexp_replace(coalesce(phone, ''), '\\D', '', 'g'), 9) = ${key}
    ORDER BY "createdAt" ASC
    LIMIT 1`;
  return rows[0]?.id ?? null;
}
