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

/**
 * How money goes into a wallet (a top-up) or comes out of it to the client
 * (a withdrawal): real money, not another wallet, a gift card or points.
 */
export const WALLET_TOP_UP_METHODS = ["cash", "card", "bizum", "bank_transfer"] as const;
export type WalletTopUpMethod = (typeof WALLET_TOP_UP_METHODS)[number];
/** The same tenders, for money handed back from the wallet. */
export const WALLET_TENDER_METHODS = WALLET_TOP_UP_METHODS;
export type WalletTenderMethod = WalletTopUpMethod;

/**
 * POST /payments/wallet/:clientId/deposit: a top-up, and how the client
 * paid it (WalletService.topUp). Cash goes into the drawer, so it needs one
 * open; the rest is linked to the open drawer, if any, for its report.
 */
export class WalletDepositDto extends WalletAmountDto {
  @IsIn(WALLET_TOP_UP_METHODS, { message: "Indica cómo paga la recarga: efectivo, tarjeta, Bizum o transferencia." })
  method!: WalletTopUpMethod;
}

/**
 * POST /payments/wallet/:clientId/withdraw: money handed back to the client
 * from her wallet, and how (WalletService.withdraw). Cash comes out of the
 * drawer, so it needs one open; the rest is linked to the open drawer, if
 * any, for its report.
 */
export class WalletWithdrawDto extends WalletAmountDto {
  @IsIn(WALLET_TENDER_METHODS, { message: "Indica cómo se le devuelve el dinero: efectivo, tarjeta, Bizum o transferencia." })
  method!: WalletTenderMethod;
}

/**
 * POST /payments/:id/refund: money given back for a charge, in cents. No
 * amount: everything not refunded yet. The reason is kept on the refund.
 */
export class RefundPaymentDto {
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
