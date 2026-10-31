import { Type } from "class-transformer";
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";
import { PaymentMethod, PaymentType } from "@prisma/client";

/**
 * Bodies of the payments routes. They were inline object types, which the
 * ValidationPipe does not see: a negative wallet "deposit" was a
 * withdrawal, a status could be any string, an amount any value.
 * Amounts are cents (payments.amount, client_wallets.balance).
 */
const MAX_CENTS = 100_000_000;

export class CreatePaymentBodyDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(MAX_CENTS)
  amount!: number;

  @IsOptional() @IsUUID()
  clientId?: string;

  @IsOptional() @IsUUID()
  appointmentId?: string;

  @IsOptional() @IsEnum(PaymentType)
  type?: PaymentType;

  @IsOptional() @IsString() @MaxLength(500)
  description?: string;

  @IsOptional() @IsEnum(PaymentMethod)
  method?: PaymentMethod;
}

export const PAYMENT_STATUSES = ["pending", "paid", "failed", "refunded"] as const;

export class UpdatePaymentStatusDto {
  @IsIn(PAYMENT_STATUSES as unknown as string[])
  status!: (typeof PAYMENT_STATUSES)[number];
}

/** A plan key (esencial, pro, empresa, or a legacy one); the service maps and checks it. */
export class SubscriptionPlanDto {
  @IsString() @MaxLength(50) @Matches(/^[a-z][a-z0-9_-]*$/)
  plan!: string;
}

export class CancelSubscriptionDto {
  @IsOptional() @IsBoolean()
  immediately?: boolean;
}

export class UpdateLocationCountDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(1000)
  locationCount!: number;
}

/**
 * A wallet movement, in cents. The payments page sends `euros * 100`,
 * which floating point can leave a hair off a whole number (10.1 * 100);
 * the controller rounds it.
 */
export class WalletAmountDto {
  @Type(() => Number) @IsNumber() @Min(1) @Max(MAX_CENTS)
  amount!: number;

  @IsOptional() @IsString() @MaxLength(500)
  description?: string;
}

export class AppointmentChargeDto {
  @Type(() => Number) @IsInt() @Min(1) @Max(MAX_CENTS)
  amount!: number;

  @IsIn(["card", "cash"])
  method!: "card" | "cash";
}
