import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsNumber,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from "class-validator";

/**
 * Body of `POST /commissions/pay/:professionalId`. It was an interface:
 * `appointmentIds` and the dates went into the `where` as they came, so an
 * object such as `{ not: "" }` was a Prisma filter, not an id. The
 * professional comes from the URL, never from the body.
 */
export class PayCommissionDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(1000)
  @IsUUID("all", { each: true })
  appointmentIds?: string[];

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  startDate?: Date;

  @IsOptional()
  @Type(() => Date)
  @IsDate()
  endDate?: Date;

  /**
   * The pending figure the "Pagar" dialog showed, in cents (it can be
   * negative after refund adjustments). If what is pending is no longer
   * this, nothing is paid (409): what is paid is always what was shown.
   */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(-100_000_000)
  @Max(100_000_000)
  expectedAmount?: number;
}
