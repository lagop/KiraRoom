import { BadRequestException } from "@nestjs/common";
import { Type } from "class-transformer";
import { IsEnum, IsIn, IsInt, IsISO8601, IsOptional, IsUUID, Max, Min } from "class-validator";
import { PaymentMethod, PaymentStatus, Prisma } from "@prisma/client";
import { addDays } from "../analytics/analytics-metrics";
import { salonInstant } from "../appointments/salon-time";

/**
 * The query of the payments list (GET /payments), of its summary cards
 * (GET /payments/stats/summary) and of its CSV (GET /exports/payments.csv).
 *
 * It was read as loose strings: a status that is not one of the enum's
 * ("succeeded", "processing"...) reached Prisma, failed validation there and
 * the page said "No se encontraron pagos"; `page=abc` or a bad date was a
 * 500; method and dates were filtered by the page over the 20 rows it had.
 */
export const PAYMENT_SORT_FIELDS = ["createdAt", "amount", "status", "method", "id"] as const;
export const MAX_PAGE_SIZE = 100;

const DATE_MESSAGE = "La fecha no es válida: usa el formato AAAA-MM-DD.";

/** The filters, shared by the list, the summary and the export. */
export class PaymentFiltersDto {
  @IsOptional()
  @IsEnum(PaymentStatus, { message: "El estado no es válido: pending, paid, failed o refunded." })
  status?: PaymentStatus;

  @IsOptional()
  @IsEnum(PaymentMethod, { message: "La forma de pago no es válida." })
  method?: PaymentMethod;

  @IsOptional()
  @IsUUID(undefined, { message: "La clienta no es válida." })
  clientId?: string;

  /** A salon calendar day (YYYY-MM-DD) or an exact instant (ISO 8601). */
  @IsOptional()
  @IsISO8601({ strict: true }, { message: DATE_MESSAGE })
  dateFrom?: string;

  /** Inclusive: a day covers the whole of it, in the salon's timezone. */
  @IsOptional()
  @IsISO8601({ strict: true }, { message: DATE_MESSAGE })
  dateTo?: string;
}

export class PaymentsListQueryDto extends PaymentFiltersDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "La página debe ser un número entero." })
  @Min(1, { message: "La página debe ser 1 o mayor." })
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "El tamaño de página debe ser un número entero." })
  @Min(1, { message: "El tamaño de página debe ser 1 o mayor." })
  @Max(MAX_PAGE_SIZE, { message: `Como máximo se pueden pedir ${MAX_PAGE_SIZE} pagos por página.` })
  limit?: number;

  @IsOptional()
  @IsIn(PAYMENT_SORT_FIELDS as unknown as string[], { message: "No se puede ordenar por ese campo." })
  sortBy?: (typeof PAYMENT_SORT_FIELDS)[number];

  @IsOptional()
  @IsIn(["asc", "desc"], { message: "El orden debe ser asc o desc." })
  sortOrder?: "asc" | "desc";
}

export interface PaymentFilters {
  status?: PaymentStatus | string;
  method?: PaymentMethod | string;
  clientId?: string;
  dateFrom?: string;
  dateTo?: string;
  /** A staff member's own professional: only payments of their appointments. */
  professionalId?: string | null;
}

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/** True when a filter needs the salon's timezone to turn a day into instants. */
export function needsTimezone(filters: Pick<PaymentFilters, "dateFrom" | "dateTo">): boolean {
  return [filters.dateFrom, filters.dateTo].some((d) => !!d && DAY_ONLY.test(d));
}

/**
 * The Prisma filter. A bare day is the salon's day (Europe/Madrid by
 * default), not the server's: the server runs in UTC, so "today" used to
 * start at 01:00 or 02:00 in Spain.
 */
export function paymentWhere(
  tenantId: string,
  filters: PaymentFilters,
  timeZone = "Europe/Madrid",
): Prisma.PaymentWhereInput {
  const where: Prisma.PaymentWhereInput = { tenantId };
  if (filters.status) where.status = filters.status as PaymentStatus;
  if (filters.method) where.method = filters.method as PaymentMethod;
  if (filters.clientId) where.clientId = filters.clientId;
  if (filters.professionalId) where.appointment = { professionalId: filters.professionalId };

  const from = filters.dateFrom
    ? DAY_ONLY.test(filters.dateFrom)
      ? salonInstant(filters.dateFrom, "00:00", timeZone)
      : new Date(filters.dateFrom)
    : null;
  // A day is inclusive: up to the salon's next midnight. An instant is the end.
  const to = filters.dateTo
    ? DAY_ONLY.test(filters.dateTo)
      ? { lt: salonInstant(addDays(filters.dateTo, 1), "00:00", timeZone) }
      : { lte: new Date(filters.dateTo) }
    : null;
  for (const d of [from, to?.lt, to?.lte]) {
    if (d && Number.isNaN(d.getTime())) throw new BadRequestException(DATE_MESSAGE);
  }
  if (from && to && (to.lt ? from.getTime() >= to.lt.getTime() : from.getTime() > to.lte!.getTime())) {
    throw new BadRequestException("La fecha desde no puede ser posterior a la fecha hasta.");
  }
  if (from || to) where.createdAt = { ...(from ? { gte: from } : {}), ...(to ?? {}) };
  return where;
}
