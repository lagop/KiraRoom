import { BadRequestException } from "@nestjs/common";
import { ClientStatus, Prisma } from "@prisma/client";

/**
 * The panel's client list, one page at a time: search, status filter,
 * sort. GET /clients answers it when `page` is sent; without `page` it
 * still returns the whole list as an array (the appointment drawer, the
 * POS, the calendar popovers and the campaign screens read it that way).
 */

export const CLIENT_LIST_SORT_FIELDS = ["firstName", "lastName", "email", "status", "createdAt"] as const;
export type ClientListSortField = (typeof CLIENT_LIST_SORT_FIELDS)[number];

export const CLIENT_PAGE_SIZE_DEFAULT = 25;
export const CLIENT_PAGE_SIZE_MAX = 100;
/** Ids a search may match before paging; a broader search is cut here. */
export const CLIENT_SEARCH_MATCH_LIMIT = 5000;

export interface ClientListQuery {
  page: number;
  pageSize: number;
  /** Lowercase, accents removed, spaces collapsed; "" when none. */
  search: string;
  /** Digit strings the phone is searched for; empty when too few digits. */
  phoneDigits: string[];
  status?: ClientStatus;
  sort: ClientListSortField;
  dir: "asc" | "desc";
}

export interface ClientPage<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** "  Pérez  GARCÍA " → "perez garcia" (what the SQL side compares with). */
export function normaliseSearchText(raw: string | null | undefined): string {
  return (raw ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The digits of a phone search ("+34 600-11 22" → "346001122"), and the
 * national number when it starts with Spain's prefix (34 / 0034), since
 * phones are stored both with and without it. Fewer than 3 digits is not
 * a phone search: "2" would match nearly every client.
 */
export function phoneDigitVariants(raw: string | null | undefined): string[] {
  const digits = (raw ?? "").replace(/\D/g, "");
  if (digits.length < 3) return [];
  const variants = [digits];
  const national = /^(?:0034|34)(\d{9})$/.exec(digits)?.[1];
  if (national) variants.push(national);
  return variants;
}

/** `%`, `_` and `\` typed in a search are literal, not LIKE wildcards. */
export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

const intParam = (value: string | undefined, name: string, fallback: number): number => {
  if (value === undefined || value === "") return fallback;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new BadRequestException(`${name} debe ser un número entero mayor que 0`);
  }
  return n;
};

/** GET /clients' paging parameters, checked. */
export function parseClientListQuery(raw: {
  page?: string;
  pageSize?: string;
  q?: string;
  status?: string;
  sort?: string;
  dir?: string;
}): ClientListQuery {
  const page = intParam(raw.page, "page", 1);
  const pageSize = Math.min(intParam(raw.pageSize, "pageSize", CLIENT_PAGE_SIZE_DEFAULT), CLIENT_PAGE_SIZE_MAX);
  let status: ClientStatus | undefined;
  if (raw.status) {
    if (!(Object.values(ClientStatus) as string[]).includes(raw.status)) {
      throw new BadRequestException("Estado de cliente no válido");
    }
    status = raw.status as ClientStatus;
  }
  const sort = (CLIENT_LIST_SORT_FIELDS as readonly string[]).includes(raw.sort ?? "")
    ? (raw.sort as ClientListSortField)
    : "createdAt";
  const dir = raw.dir === "asc" ? "asc" : raw.dir === "desc" ? "desc" : sort === "createdAt" ? "desc" : "asc";
  const q = (raw.q ?? "").slice(0, 100);
  return { page, pageSize, search: normaliseSearchText(q), phoneDigits: phoneDigitVariants(q), status, sort, dir };
}

/** The order of a page: the chosen column, then a stable tie-break. */
export function clientListOrderBy(query: Pick<ClientListQuery, "sort" | "dir">): Prisma.ClientOrderByWithRelationInput[] {
  const { sort, dir } = query;
  const order: Prisma.ClientOrderByWithRelationInput[] = [{ [sort]: dir }];
  if (sort === "firstName") order.push({ lastName: dir });
  if (sort === "lastName") order.push({ firstName: dir });
  order.push({ id: "asc" });
  return order;
}

// Lowercase accented letters and their plain form, for Postgres translate().
// `unaccent` is an extension the database does not have; translate() is
// built in. lower() runs first, so capitals are covered.
const ACCENTED = "áàâäãåéèêëíìîïóòôöõúùûüñçý";
const PLAIN = "aaaaaaeeeeiiiiooooouuuuncy";

const folded = (column: Prisma.Sql) => Prisma.sql`translate(lower(${column}), ${ACCENTED}, ${PLAIN})`;

/**
 * The SQL that finds a salon's clients matching a search: name (either
 * order, accents ignored), email, or phone digits (spaces, "+", dashes
 * ignored). Raw SQL because Prisma's `contains` cannot fold accents; every
 * value is a bound parameter. $queryRaw bypasses the tenant-scope
 * extension, hence the explicit tenant filter.
 */
export function clientSearchSql(tenantId: string, query: Pick<ClientListQuery, "search" | "phoneDigits">): Prisma.Sql {
  const conditions: Prisma.Sql[] = [];
  if (query.search) {
    const like = likeContains(query.search);
    conditions.push(
      Prisma.sql`${folded(Prisma.sql`"firstName" || ' ' || "lastName"`)} LIKE ${like}`,
      Prisma.sql`${folded(Prisma.sql`"lastName" || ' ' || "firstName"`)} LIKE ${like}`,
      Prisma.sql`${folded(Prisma.sql`coalesce("email", '')`)} LIKE ${like}`,
    );
  }
  for (const digits of query.phoneDigits) {
    conditions.push(
      Prisma.sql`regexp_replace(coalesce("phone", ''), '[^0-9]', '', 'g') LIKE ${likeContains(digits)}`,
    );
  }
  return Prisma.sql`SELECT "id" FROM "clients" WHERE "tenantId" = ${tenantId} AND (${Prisma.join(
    conditions,
    " OR ",
  )}) LIMIT ${CLIENT_SEARCH_MATCH_LIMIT}`;
}

/** The day `years` years before `day` (UTC); 29 February → 28 in a common year. */
function yearsBefore(day: Date, years: number): Date {
  const y = day.getUTCFullYear() - years;
  const m = day.getUTCMonth();
  const lastOfMonth = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m, Math.min(day.getUTCDate(), lastOfMonth)));
}

const nextDay = (d: Date) => new Date(d.getTime() + 24 * 60 * 60 * 1000);

/**
 * The birth dates of the clients aged between `minAge` and `maxAge`
 * (inclusive) on `now`'s day.
 *
 * - age ≥ min: born on or before the day `min` years ago.
 * - age ≤ max: not yet max + 1, so born after the day `max + 1` years ago.
 *   It used `gte` on that day, which also took whoever turns max + 1 today.
 *
 * Both bounds are whole days (`lt` / `gte` the next midnight), so a birth
 * date stored with a time of day still lands on its day.
 */
export function birthDateRange(
  now: Date,
  minAge?: number,
  maxAge?: number,
): { lt?: Date; gte?: Date } | undefined {
  if (minAge === undefined && maxAge === undefined) return undefined;
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const range: { lt?: Date; gte?: Date } = {};
  if (minAge !== undefined) range.lt = nextDay(yearsBefore(today, minAge));
  if (maxAge !== undefined) range.gte = nextDay(yearsBefore(today, maxAge + 1));
  return range;
}
