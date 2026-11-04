import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsDate,
  IsIn,
  IsString,
  Matches,
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

  /** "Pagar hasta": the last salon day paid (both ends included). */
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

/** Body of `PATCH /commissions/settings` (owner or admin). Rates in percent. */
export class UpdateCommissionSettingsDto {
  /** "Comisión por defecto": services, when neither the appointment nor the professional has a rate. */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  defaultRate?: number;

  /** Products sold at the till, when the professional has no "Comisión de productos". */
  @IsOptional()
  @Type(() => Number)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(100)
  productDefaultRate?: number;

  /** "Comisión sobre": "net" (without the tax) or "gross" (with it). */
  @IsOptional()
  @IsIn(["net", "gross"])
  base?: "net" | "gross";
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Query of `GET /commissions/summary/:id`: "Pagar hasta", a salon day. */
export class CommissionSummaryQueryDto {
  @IsOptional()
  @IsString()
  @Matches(DAY, { message: "Indica la fecha como AAAA-MM-DD." })
  upTo?: string;
}

/** Query of the payroll report, its CSV and a statement: both days included. */
export class CommissionPeriodQueryDto {
  @IsString()
  @Matches(DAY, { message: "Indica la fecha de inicio como AAAA-MM-DD." })
  startDate!: string;

  @IsString()
  @Matches(DAY, { message: "Indica la fecha de fin como AAAA-MM-DD." })
  endDate!: string;
}

/** Query of `GET /commissions/payouts`. */
export class CommissionPayoutsQueryDto {
  @IsOptional()
  @IsUUID()
  professionalId?: string;

  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  @Min(1)
  @Max(500)
  limit?: number;
}
