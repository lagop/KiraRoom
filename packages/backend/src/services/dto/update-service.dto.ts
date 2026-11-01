import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsString,
  IsNumber,
  IsBoolean,
  IsOptional,
  IsNotEmpty,
  IsEnum,
  IsIn,
  IsInt,
  Min,
  Max,
  ValidateIf,
} from 'class-validator';
import { ServiceCategory } from '@prisma/client';
import { SERVICE_CURRENCIES, SERVICE_LIMITS as L, numberFromText, trimmed } from './service-fields';

/**
 * Left out, a field is not changed. Sent, it must be valid -- null too:
 * `@IsOptional()` lets null through, and a null into a NOT NULL column
 * (name, price, duration...) came back from Postgres as a 500. Nullable
 * columns (description, deposit amount and percentage) keep IsOptional, so
 * null still clears them.
 */
const IfSent = () => ValidateIf((_o: unknown, value: unknown) => value !== undefined);

/** The same limits as CreateServiceDto (service-fields.ts). */
export class UpdateServiceDto {
  @ApiProperty({ description: 'Service name', required: false })
  @Transform(trimmed)
  @IfSent()
  @IsString({ message: 'El nombre no es válido' })
  @IsNotEmpty({ message: 'Escribe el nombre del servicio' })
  name?: string;

  @ApiProperty({ description: 'Service description', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ description: 'Service category', enum: ServiceCategory, required: false })
  @IfSent()
  @IsEnum(ServiceCategory, {
    message: `category must be one of: ${Object.values(ServiceCategory).join(", ")}`,
  })
  category?: ServiceCategory;

  @ApiProperty({ description: 'Service duration in minutes', required: false })
  @Transform(numberFromText)
  @IfSent()
  @IsInt({ message: 'La duración tiene que ser un número entero de minutos' })
  @Min(L.durationMin, { message: `La duración mínima es de ${L.durationMin} minutos` })
  @Max(L.durationMax, { message: `La duración máxima es de ${L.durationMax} minutos` })
  duration?: number;

  @ApiProperty({ description: 'Service price', required: false })
  @Transform(numberFromText)
  @IfSent()
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'El precio tiene que ser un importe con 2 decimales como máximo' })
  @Min(0, { message: 'El precio no puede ser negativo' })
  @Max(L.priceMax, { message: `El precio máximo es ${L.priceMax} €` })
  price?: number;

  @ApiProperty({ description: 'Service currency', required: false, enum: SERVICE_CURRENCIES })
  @IfSent()
  @IsIn(SERVICE_CURRENCIES, { message: 'La única moneda disponible es EUR' })
  currency?: string;

  @ApiProperty({ description: 'Is service active', required: false })
  @IfSent()
  @IsBoolean()
  isActive?: boolean;

  @ApiProperty({ description: 'Requires approval', required: false })
  @IfSent()
  @IsBoolean()
  requiresApproval?: boolean;

  @ApiProperty({ description: 'Max advance booking days', required: false })
  @Transform(numberFromText)
  @IfSent()
  @IsInt({ message: 'La antelación máxima tiene que ser un número entero de días' })
  @Min(1, { message: 'La antelación máxima es de al menos 1 día' })
  @Max(L.maxAdvanceDaysMax, { message: `La antelación máxima no puede pasar de ${L.maxAdvanceDaysMax} días` })
  maxAdvanceBooking?: number;

  @ApiProperty({ description: 'Min advance booking hours', required: false })
  @Transform(numberFromText)
  @IfSent()
  @IsInt({ message: 'La antelación mínima tiene que ser un número entero de horas' })
  @Min(0, { message: 'La antelación mínima no puede ser negativa' })
  @Max(L.minAdvanceHoursMax, { message: `La antelación mínima no puede pasar de ${L.minAdvanceHoursMax} horas` })
  minAdvanceBooking?: number;

  @ApiProperty({ description: 'Buffer time in minutes', required: false })
  @Transform(numberFromText)
  @IfSent()
  @IsInt({ message: 'El margen tiene que ser un número entero de minutos' })
  @Min(0, { message: 'El margen no puede ser negativo' })
  @Max(L.bufferMax, { message: `El margen máximo es de ${L.bufferMax} minutos` })
  bufferTime?: number;

  @ApiProperty({ description: 'Is online bookable', required: false })
  @IfSent()
  @IsBoolean()
  isOnlineBookable?: boolean;

  @ApiProperty({ description: 'Is mobile service', required: false })
  @IfSent()
  @IsBoolean()
  isMobile?: boolean;

  @ApiProperty({ description: 'Requires deposit payment', required: false })
  @IfSent()
  @IsBoolean()
  depositRequired?: boolean;

  @ApiProperty({ description: 'Deposit amount (fixed)', required: false })
  @Transform(numberFromText)
  @IsNumber({}, { message: 'La señal no es un importe válido' })
  @Min(0, { message: 'La señal no puede ser negativa' })
  @IsOptional()
  depositAmount?: number;

  @ApiProperty({ description: 'Deposit percentage (of total price)', required: false })
  @Transform(numberFromText)
  @IsNumber({}, { message: 'El porcentaje de señal no es válido' })
  @Min(0, { message: 'El porcentaje de señal no puede ser negativo' })
  @Max(100, { message: 'El porcentaje de señal no puede pasar del 100 %' })
  @IsOptional()
  depositPercentage?: number;
}
