import {
  IsUUID,
  IsString,
  IsDateString,
  IsOptional,
  IsEnum,
  IsNumber,
  IsInt,
  IsBoolean,
  IsArray,
  ArrayMaxSize,
  MaxLength,
  Matches,
  Min,
  Max,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { AppointmentStatus } from '@prisma/client';

export class AppointmentAddonDto {
  @IsUUID()
  addonId!: string;

  @IsInt()
  @Min(1)
  @Max(99)
  quantity!: number;
}

export class AppointmentServiceItemDto {
  @IsUUID()
  serviceId!: string;

  @IsOptional()
  @IsUUID()
  professionalId?: string | null;

  @IsOptional()
  @IsBoolean()
  isParallel?: boolean;
}

/**
 * The body of `PATCH /appointments/:id`. The controller used to type it
 * with a same-named interface, which the ValidationPipe cannot see, so
 * any column -- and nested writes into the salon and its users -- went
 * straight into the update. Only these fields are read now; the service
 * also builds the update from them one by one.
 */
export class UpdateAppointmentDto {
  @ApiPropertyOptional({ description: 'Service ID' })
  @IsUUID()
  @IsOptional()
  serviceId?: string;

  @ApiPropertyOptional({ description: 'Professional ID' })
  @IsUUID()
  @IsOptional()
  professionalId?: string;

  @ApiPropertyOptional({ description: 'Client ID' })
  @IsUUID()
  @IsOptional()
  clientId?: string;

  @ApiPropertyOptional({ description: 'Scheduled date', example: '2024-01-15' })
  @IsDateString()
  @IsOptional()
  scheduledDate?: string;

  @ApiPropertyOptional({ description: 'Scheduled time', example: '14:30' })
  @Matches(/^([01]\d|2[0-3]):[0-5]\d(:[0-5]\d)?$/)
  @IsOptional()
  scheduledTime?: string;

  @ApiPropertyOptional({ description: 'Appointment notes' })
  @IsString()
  @MaxLength(5000)
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional({ description: 'Appointment status', enum: AppointmentStatus })
  @IsEnum(AppointmentStatus)
  @IsOptional()
  status?: AppointmentStatus;

  @ApiPropertyOptional({ description: 'Add-ons for the service' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @ValidateNested({ each: true })
  @Type(() => AppointmentAddonDto)
  addons?: AppointmentAddonDto[];

  @ApiPropertyOptional({ description: 'Cancellation reason' })
  @IsString()
  @MaxLength(1000)
  @IsOptional()
  cancellationReason?: string;

  @ApiPropertyOptional({ description: 'Commission rate override (percentage) - admin/owner only' })
  // Decimal columns come back from the API as strings, and the panel
  // resends them as it got them.
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  commissionRate?: number;

  @ApiPropertyOptional({ description: 'Deposit required - admin/owner only' })
  @IsOptional()
  @IsBoolean()
  depositRequired?: boolean;

  @ApiPropertyOptional({ description: 'Deposit amount - admin/owner only' })
  @Type(() => Number)
  @IsOptional()
  @IsNumber()
  @Min(0)
  depositAmount?: number;

  @ApiPropertyOptional({ description: 'Services for multi-service appointments' })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ValidateNested({ each: true })
  @Type(() => AppointmentServiceItemDto)
  services?: AppointmentServiceItemDto[];
}
