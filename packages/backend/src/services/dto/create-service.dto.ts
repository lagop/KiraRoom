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
} from 'class-validator';
import { ServiceCategory } from '@prisma/client';
import { SERVICE_CURRENCIES, SERVICE_LIMITS as L, numberFromText, trimmed } from './service-fields';

/**
 * No `tenantId` here on purpose: the tenant comes from the caller's token.
 * The dashboard used to send placeholders ('demo-tenant', 'default-tenant',
 * '1'), which the tenant scope rejected with a 403 -- so every screen but the
 * onboarding wizard failed to create a service. The global ValidationPipe
 * whitelists, so an old client still sending the field has it stripped.
 *
 * Limits: see service-fields.ts.
 */
export class CreateServiceDto {
  @ApiProperty({ description: 'Service name' })
  @Transform(trimmed)
  @IsString({ message: 'El nombre no es válido' })
  @IsNotEmpty({ message: 'Escribe el nombre del servicio' })
  name: string;

  @ApiProperty({ description: 'Service description', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  // One of the database's categories: anything else used to reach Postgres
  // and come back as a 500 instead of a 400 saying what is allowed.
  @ApiProperty({ description: 'Service category', enum: ServiceCategory })
  @IsEnum(ServiceCategory, {
    message: `category must be one of: ${Object.values(ServiceCategory).join(", ")}`,
  })
  category: ServiceCategory;

  @ApiProperty({ description: 'Service duration in minutes' })
  @Transform(numberFromText)
  @IsInt({ message: 'La duración tiene que ser un número entero de minutos' })
  @Min(L.durationMin, { message: `La duración mínima es de ${L.durationMin} minutos` })
  @Max(L.durationMax, { message: `La duración máxima es de ${L.durationMax} minutos` })
  duration: number;

  @ApiProperty({ description: 'Service price' })
  @Transform(numberFromText)
  @IsNumber({ maxDecimalPlaces: 2 }, { message: 'El precio tiene que ser un importe con 2 decimales como máximo' })
  @Min(0, { message: 'El precio no puede ser negativo' })
  @Max(L.priceMax, { message: `El precio máximo es ${L.priceMax} €` })
  price: number;

  @ApiProperty({ description: 'Service currency', required: false, enum: SERVICE_CURRENCIES })
  @IsIn(SERVICE_CURRENCIES, { message: 'La única moneda disponible es EUR' })
  @IsOptional()
  currency?: string;

  @ApiProperty({ description: 'Is service active', required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiProperty({ description: 'Requires approval', required: false })
  @IsBoolean()
  @IsOptional()
  requiresApproval?: boolean;

  @ApiProperty({ description: 'Max advance booking days', required: false })
  @Transform(numberFromText)
  @IsInt({ message: 'La antelación máxima tiene que ser un número entero de días' })
  @Min(1, { message: 'La antelación máxima es de al menos 1 día' })
  @Max(L.maxAdvanceDaysMax, { message: `La antelación máxima no puede pasar de ${L.maxAdvanceDaysMax} días` })
  @IsOptional()
  maxAdvanceBooking?: number;

  @ApiProperty({ description: 'Min advance booking hours', required: false })
  @Transform(numberFromText)
  @IsInt({ message: 'La antelación mínima tiene que ser un número entero de horas' })
  @Min(0, { message: 'La antelación mínima no puede ser negativa' })
  @Max(L.minAdvanceHoursMax, { message: `La antelación mínima no puede pasar de ${L.minAdvanceHoursMax} horas` })
  @IsOptional()
  minAdvanceBooking?: number;

  @ApiProperty({ description: 'Buffer time in minutes', required: false })
  @Transform(numberFromText)
  @IsInt({ message: 'El margen tiene que ser un número entero de minutos' })
  @Min(0, { message: 'El margen no puede ser negativo' })
  @Max(L.bufferMax, { message: `El margen máximo es de ${L.bufferMax} minutos` })
  @IsOptional()
  bufferTime?: number;

  @ApiProperty({ description: 'Is online bookable', required: false })
  @IsBoolean()
  @IsOptional()
  isOnlineBookable?: boolean;

  @ApiProperty({ description: 'Is mobile service', required: false })
  @IsBoolean()
  @IsOptional()
  isMobile?: boolean;

  @ApiProperty({ description: 'Requires deposit payment', required: false })
  @IsBoolean()
  @IsOptional()
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
