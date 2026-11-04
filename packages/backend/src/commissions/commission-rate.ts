/**
 * Which commission rate applies, read without truthiness: 0 is a rate (no
 * commission), only a missing value (null or undefined) falls through to the
 * next one.
 *
 * The service read `professional.commissionRate ? Number(...) : 10`. That
 * worked for a rate of 0 only because Prisma hands Decimal columns over as
 * objects, which are truthy even at 0; a plain number 0 (a mock, a raw
 * query, a value already converted) became the 10 % default. The same for a
 * stored commission amount of 0, which was recomputed.
 */

/**
 * The last resort when not even the salon's "Comisión por defecto" is known
 * (a row read without it). Every real read passes the salon's default as the
 * last candidate (commission-terms.ts); the 10 % that used to be hard-coded
 * here is now that setting's value for the salons that existed before it.
 */
export const DEFAULT_COMMISSION_RATE = 0;

/** A stored or given amount or rate as a number; null, undefined, "" or not a number: null. Decimals are read with Number(). */
export function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/**
 * The first rate that is set (0 included), most specific first: the
 * appointment's or line's own, the professional's, the salon's default.
 * None: DEFAULT_COMMISSION_RATE.
 */
export function effectiveCommissionRate(...candidates: unknown[]): number {
  for (const candidate of candidates) {
    const rate = numberOrNull(candidate);
    if (rate !== null) return rate;
  }
  return DEFAULT_COMMISSION_RATE;
}
