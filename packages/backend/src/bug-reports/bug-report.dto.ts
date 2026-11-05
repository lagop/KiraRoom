import {
  IsEmail,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  ValidateBy,
  ValidationOptions,
} from "class-validator";
import { EmptyStringToUndefined } from "../common/dto/empty-to-undefined";

/** Longest page address a report keeps. */
export const MAX_BUG_URL_LENGTH = 2000;

/**
 * Whether `value` is an absolute http(s) URL. The console shows the page
 * address as a link, so anything with another scheme is refused here (and the
 * console still renders old rows as plain text).
 */
export function isHttpUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.length > MAX_BUG_URL_LENGTH) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** class-validator wrapper; IsUrl refuses localhost, which the panel runs on in dev. */
function IsHttpUrl(options?: ValidationOptions): PropertyDecorator {
  return ValidateBy(
    {
      name: "isHttpUrl",
      validator: {
        validate: (value) => isHttpUrl(value),
        defaultMessage: () => "currentUrl must be an http(s) URL",
      },
    },
    options,
  );
}

/**
 * Body of `POST /bug-reports`. It was an interface, so any key and any size
 * reached the row and the founder's email. The tenant and author come from
 * the session, never from here.
 */
export class BugReportDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  subject!: string;

  @IsString() @IsNotEmpty() @MaxLength(5000)
  description!: string;

  /** Filled in by the frontend with the page the report was sent from. */
  @EmptyStringToUndefined() @IsOptional() @IsString() @MaxLength(MAX_BUG_URL_LENGTH) @IsHttpUrl()
  currentUrl?: string;

  @IsOptional() @IsString() @MaxLength(100)
  appVersion?: string;

  /**
   * The email the modal pre-fills. Kept on the row only for a report without
   * a session; the acknowledgement always goes to the signed-in account's own
   * address, never to this one.
   */
  @EmptyStringToUndefined() @IsOptional() @IsEmail() @MaxLength(254)
  email?: string;

  /** Free-form JSON for additional context (capped by the controller). */
  @IsOptional() @IsObject()
  context?: Record<string, unknown>;
}

/** The context is stored as JSON and pasted into an email. */
export const MAX_BUG_CONTEXT_BYTES = 20_000;
