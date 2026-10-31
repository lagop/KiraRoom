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
 * Body of `POST /commissions/calculate/:appointmentId`. Both fields are
 * optional overrides; without them the appointment's total and the
 * professional's rate are used. The body used to be an inline type, so a
 * negative amount or a 900 % rate went straight into the appointment.
 */
export class CalculateCommissionBodyDto {
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(1_000_000)
  amount?: number;

  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  rate?: number;
}

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
}
