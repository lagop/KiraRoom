import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
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

/** A line of a till sale given back: its id (GET /payments/:id/refund-lines) and how many units. */
export class RefundLineDto {
  @IsUUID("4", { message: "Una de las líneas elegidas no es válida." })
  lineId!: string;

  @Type(() => Number)
  @IsInt({ message: "Las unidades a devolver deben ser un número entero." })
  @Min(1, { message: "Las unidades a devolver deben ser al menos 1." })
  @Max(10_000, { message: "Las unidades a devolver no son válidas." })
  quantity!: number;
}

/**
 * POST /payments/:id/refund: money given back for a charge, in cents. No
 * amount: everything not refunded yet, or, with `lines`, what those units
 * are worth. The reason is kept on the refund. `lines` (a till sale's own
 * payment only): the units given back; products return to stock
 * (payments/refund-lines.ts). An amount without lines restocks nothing.
 */
export class RefundPaymentDto {
  @IsOptional()
  @IsArray({ message: "Las líneas a devolver no son válidas." })
  @ArrayMaxSize(200, { message: "Demasiadas líneas en una devolución." })
  @ValidateNested({ each: true })
  @Type(() => RefundLineDto)
  lines?: RefundLineDto[];

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "El importe a devolver debe ser un número entero de céntimos." })
  @Min(1, { message: "El importe a devolver debe ser mayor que 0." })
  @Max(MAX_CENTS, { message: "El importe a devolver no es válido." })
  amount?: number;

  @IsString({ message: "Indica el motivo de la devolución." })
  @Matches(/\S/, { message: "Indica el motivo de la devolución." })
  @MaxLength(500, { message: "El motivo puede tener como máximo 500 caracteres." })
  reason!: string;
}
