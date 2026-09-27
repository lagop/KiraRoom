import { Transform } from "class-transformer";

/**
 * Treats an empty string as "not sent".
 *
 * `@IsOptional()` in class-validator skips validation only for `undefined` and
 * `null`. An empty string is a value, so it is validated — and `@IsUrl()`
 * rejects it.
 *
 * Every HTML form produces empty strings. The owner console's tenant editor
 * hydrates its state with `website: tenant.website || ""` and submits the whole
 * object, so editing a tenant that has no website sent `website: ""` and the
 * request failed with 400. Since a newly signed-up salon has no website, no
 * logo and no cover image, **no new tenant could be edited from the console at
 * all** — every save failed, on a field the operator had not touched.
 *
 * It cost three failed attempts to change one timezone before the logs showed
 * why, because the console reported a generic message rather than the field.
 *
 * Put this above `@IsOptional()` so the transform runs first:
 *
 *     @EmptyStringToUndefined()
 *     @IsOptional()
 *     @IsUrl()
 *     website?: string;
 *
 * Only whitespace-only strings are affected. A meaningful value passes through
 * untouched, and `null` stays `null` — clearing a field on purpose still works.
 */
export function EmptyStringToUndefined(): PropertyDecorator {
  return Transform(({ value }) =>
    typeof value === "string" && value.trim() === "" ? undefined : value,
  );
}
