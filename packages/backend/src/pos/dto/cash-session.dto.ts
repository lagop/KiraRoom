import { Type } from "class-transformer";
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from "class-validator";

/** Cents: what a salon's drawer could hold, generously (100.000 €). */
const MAX_DRAWER_CENTS = 10_000_000;

/** POST /pos/cash-sessions/open: the float the drawer starts with. */
export class OpenCashSessionDto {
  @Type(() => Number)
  @IsInt({ message: "El fondo de caja va en céntimos: un número entero." })
  @Min(0, { message: "El fondo de caja no puede ser negativo." })
  @Max(MAX_DRAWER_CENTS, { message: "El fondo de caja no es válido." })
  openingFloatCents!: number;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

/** POST /pos/cash-sessions/:id/close: the cash counted in the drawer. */
export class CloseCashSessionDto {
  @Type(() => Number)
  @IsInt({ message: "El efectivo contado va en céntimos: un número entero." })
  @Min(0, { message: "El efectivo contado no puede ser negativo." })
  @Max(MAX_DRAWER_CENTS, { message: "El efectivo contado no es válido." })
  countedCashCents!: number;

  /** Optional count by coin and note: { "5000": 2 } is two 50 € notes. Checked by the service. */
  @IsOptional()
  @IsObject()
  breakdown?: Record<string, number>;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}

export const CASH_MOVEMENT_TYPES = ["in", "out"] as const;

/** POST /pos/cash-sessions/:id/movements: money put into or taken out of the drawer. */
export class CashMovementDto {
  @IsIn(CASH_MOVEMENT_TYPES, { message: "Elige si es una entrada o una salida de caja." })
  type!: (typeof CASH_MOVEMENT_TYPES)[number];

  @Type(() => Number)
  @IsInt({ message: "El importe va en céntimos: un número entero." })
  @Min(1, { message: "El importe debe ser mayor que 0." })
  @Max(MAX_DRAWER_CENTS, { message: "El importe no es válido." })
  amountCents!: number;

  @IsString({ message: "Indica el motivo." })
  @IsNotEmpty({ message: "Indica el motivo." })
  @MaxLength(300)
  reason!: string;
}

/** GET /pos/cash-sessions: the history (owner and managers). */
export class CashSessionListQueryDto {
  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "Fecha no válida (AAAA-MM-DD)." })
  from?: string;

  @IsOptional()
  @Matches(/^\d{4}-\d{2}-\d{2}$/, { message: "Fecha no válida (AAAA-MM-DD)." })
  to?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}
