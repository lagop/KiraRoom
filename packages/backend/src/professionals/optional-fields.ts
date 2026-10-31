import { Transform } from "class-transformer";

/**
 * Optional professional fields as an update writes them: left out (undefined)
 * leaves what is stored, null clears it, a value sets it.
 *
 * `update()` wrote `commissionRate: dto.commissionRate ? parseFloat(...) : null`,
 * so any update that did not mention the rate -- a schedule change, a new
 * phone -- wiped it, and a rate of 0, which is a real rate, was stored as
 * "none" too. `terminationDate` could not be cleared at all (null was read
 * as "leave it"), so a professional taken back on kept their leaving date.
 */

/** undefined: leave it; null or "": clear it; a number (0 included) or numeric string: set it. */
export function commissionRateUpdate(value: unknown): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const rate = typeof value === "number" ? value : parseFloat(String(value));
  // The DTO refuses anything else; never turn a bad value into a wipe.
  return Number.isFinite(rate) ? rate : undefined;
}

/** undefined: leave it; null or "": clear it; anything else: that date. */
export function optionalDateUpdate(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return new Date(value as string);
}

/**
 * For a DTO's `commissionRate`: a numeric string ("12.5", as forms send it)
 * becomes the number; "" becomes null (clear). Pair with @IsOptional() and
 * @IsNumber() so anything else is refused with a reason.
 */
export function CommissionRateInput(): PropertyDecorator {
  return Transform(({ value }) => {
    if (value === "") return null;
    if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
      return Number(value);
    }
    return value;
  });
}
