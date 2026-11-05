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
import { WIDGET_ORIGIN_RE as ORIGIN, normalizeWidgetOrigin } from "./frame-origins";

/** "https://MiSalon.com/ " -> "https://misalon.com": what people paste (frame-origins.ts). */
const normalizeOrigins = () =>
  Transform(({ value }) =>
    Array.isArray(value) ? value.map((v) => (typeof v === "string" ? normalizeWidgetOrigin(v) : v)) : value,
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
  @Matches(ORIGIN, { each: true, message: "Cada origen permitido tiene que ser una dirección https, como https://misalon.com" })
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
  @Matches(ORIGIN, { each: true, message: "Cada origen permitido tiene que ser una dirección https, como https://misalon.com" })
  @MaxLength(253, { each: true })
  allowedOrigins?: string[];

  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID("all", { each: true })
  services?: string[];

  @IsOptional() @IsArray() @ArrayMaxSize(500) @IsUUID("all", { each: true })
  professionals?: string[];

  @IsOptional() @IsObject()
  theme?: Record<string, unknown>;
}
