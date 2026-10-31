import { Transform } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from "class-validator";

/**
 * An origin as CSP `frame-ancestors` takes it: scheme, host (optionally
 * `*.` for subdomains) and port, nothing else. The list is joined into
 * that header, so a `;` or a space in an entry would add directives.
 */
const ORIGIN = /^https?:\/\/(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*(:\d{1,5})?$/i;

/** "https://misalon.com/ " -> "https://misalon.com": what people paste. */
const normalizeOrigins = () =>
  Transform(({ value }) =>
    Array.isArray(value)
      ? value.map((v) => (typeof v === "string" ? v.trim().replace(/\/+$/, "") : v))
      : value,
  );

/** The theme is stored as JSON and served on every public embed. */
export const MAX_WIDGET_THEME_BYTES = 5_000;

/**
 * Body of `POST /widget/instances`. These classes had no decorators, so
 * the global pipe stripped every field and creating a widget always failed
 * with "name is required"; once fixed they would have taken anything.
 */
export class CreateWidgetDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  name!: string;

  @IsOptional() @normalizeOrigins() @IsArray() @ArrayMaxSize(20)
  @Matches(ORIGIN, { each: true, message: "each allowed origin must look like https://misalon.com" })
  @MaxLength(253, { each: true })
  allowedOrigins?: string[];

  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID("all", { each: true })
  services?: string[];

  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID("all", { each: true })
  professionals?: string[];

  @IsOptional() @IsObject()
  theme?: Record<string, unknown>;
}

/** Body of `PATCH /widget/instances/:id`. */
export class UpdateWidgetDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200)
  name?: string;

  @IsOptional() @normalizeOrigins() @IsArray() @ArrayMaxSize(20)
  @Matches(ORIGIN, { each: true, message: "each allowed origin must look like https://misalon.com" })
  @MaxLength(253, { each: true })
  allowedOrigins?: string[];

  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID("all", { each: true })
  services?: string[];

  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID("all", { each: true })
  professionals?: string[];

  @IsOptional() @IsObject()
  theme?: Record<string, unknown>;
}
