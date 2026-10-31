import {
  IsEmail,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
} from "class-validator";
import { EmptyStringToUndefined } from "../common/dto/empty-to-undefined";

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

  /** Filled in by the frontend; a plain string (localhost URLs are not "URLs" to IsUrl). */
  @IsOptional() @IsString() @MaxLength(2000)
  currentUrl?: string;

  @IsOptional() @IsString() @MaxLength(100)
  appVersion?: string;

  /**
   * Optional email of the reporter. When provided, an automated
   * acknowledgement is sent back so the reporter has a tracking id
   * they can reference. Anonymous reports (no email) skip the ack.
   */
  @EmptyStringToUndefined() @IsOptional() @IsEmail() @MaxLength(254)
  email?: string;

  /** Free-form JSON for additional context (capped by the controller). */
  @IsOptional() @IsObject()
  context?: Record<string, unknown>;
}

/** The context is stored as JSON and pasted into an email. */
export const MAX_BUG_CONTEXT_BYTES = 20_000;
