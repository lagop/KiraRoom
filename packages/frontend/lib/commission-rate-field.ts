/**
 * The commission rate field of the professionals list's add/edit modal
 * (dashboard/professionals/page.tsx), as text, and what a save sends for it.
 *
 * The modal kept the rate as a number and sent it only when it was truthy,
 * so an owner could not set a rate of 0 (a real rate: no commission) nor
 * clear one. The API (PATCH /admin/professionals/:id) reads the field as:
 * left out keeps what is stored, null clears it (the salon's default rate
 * applies), a number sets it, 0 included.
 *
 * No React and no Next imports, so lib/commission-rate-field.spec.ts can run them.
 */

/** The stored rate as the field shows it: "" for none. Prisma's Decimal arrives as a string. */
export function commissionRateFieldValue(stored: number | string | null | undefined): string {
  if (stored === null || stored === undefined) return "";
  const n = Number(stored);
  return Number.isFinite(n) ? String(n) : "";
}

/** The field as typed, as a rate; null when empty. NaN when it is not a number. */
function parseRate(value: string): number | null {
  const text = value.trim().replace(",", ".");
  if (text === "") return null;
  return Number(text);
}

/**
 * What an update sends for the rate, given the field now and as the modal
 * opened it:
 *   unchanged          -> undefined (left out: the stored rate is kept);
 *   emptied            -> null (cleared);
 *   a number, 0 too    -> that number.
 * Not a number: undefined, never a wipe (the input's own validation refuses it first).
 */
export function commissionRateForUpdate(value: string, initial: string): number | null | undefined {
  const now = parseRate(value);
  const before = parseRate(initial);
  if (now === before || (Number.isNaN(now) && Number.isNaN(before))) return undefined;
  if (now === null) return null;
  return Number.isFinite(now) ? now : undefined;
}

/** What a create sends: the number typed (0 included), or nothing when empty. */
export function commissionRateForCreate(value: string): number | undefined {
  const rate = parseRate(value);
  return rate !== null && Number.isFinite(rate) ? rate : undefined;
}
