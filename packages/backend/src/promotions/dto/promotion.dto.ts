import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { PromotionType } from "@prisma/client";

/** A code is typed at the till and goes in a URL (`/promotions/validate/:code`): no spaces. */
const CODE = /^\S+$/;
const MAX_AMOUNT = 1_000_000;

/**
 * Body of `POST /promotions`. These were interfaces, which the
 * ValidationPipe does not see: any type, a negative value or a 10 000 %
 * discount went into the promotion. The service still builds `data` field
 * by field; that a percentage is at most 100 is checked there, because on
 * an edit the type may be the stored one.
 */
export class CreatePromotionDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  name!: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string | null;

  @IsString() @MaxLength(50) @Matches(CODE, { message: "El código no puede tener espacios." })
  code!: string;

  @IsEnum(PromotionType)
  type!: PromotionType;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_AMOUNT)
  value!: number;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_AMOUNT)
  minOrderValue?: number | null;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000)
  maxUses?: number | null;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000)
  maxUsesPerClient?: number | null;

  @IsDateString()
  startDate!: string;

  @IsOptional() @IsDateString()
  endDate?: string | null;

  /** Only these services get the discount at the till; empty or left out: the whole ticket. */
  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID("all", { each: true })
  applicableServiceIds?: string[];
}

/**
 * Body of `PUT /promotions/:id`. The panel sends the whole form again
 * (code included, which cannot change and is dropped), or just `isActive`.
 */
export class UpdatePromotionDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200)
  name?: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string | null;

  @IsOptional() @IsEnum(PromotionType)
  type?: PromotionType;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_AMOUNT)
  value?: number;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_AMOUNT)
  minOrderValue?: number | null;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000)
  maxUses?: number | null;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(1_000_000)
  maxUsesPerClient?: number | null;

  @IsOptional() @IsDateString()
  startDate?: string;

  @IsOptional() @IsDateString()
  endDate?: string | null;

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  @IsOptional() @IsArray() @ArrayMaxSize(200) @IsUUID("all", { each: true })
  applicableServiceIds?: string[];
}
