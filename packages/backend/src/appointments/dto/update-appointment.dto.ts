import { IsUUID, IsString, IsDateString, IsOptional, IsEnum, IsNumber, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AppointmentStatus } from '@prisma/client';

export class UpdateAppointmentDto {
  @ApiPropertyOptional({ description: 'Service ID' })
  @IsUUID()
  @IsOptional()
  serviceId?: string;

  @ApiPropertyOptional({ description: 'Professional ID' })
  @IsUUID()
  @IsOptional()
  professionalId?: string;

  @ApiPropertyOptional({ description: 'Scheduled date', example: '2024-01-15' })
  @IsDateString()
  @IsOptional()
  scheduledDate?: Date;

  @ApiPropertyOptional({ description: 'Scheduled time', example: '14:30' })
  @IsString()
  @IsOptional()
  scheduledTime?: string;

  @ApiPropertyOptional({ description: 'Appointment notes' })
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiPropertyOptional({ description: 'Appointment status', enum: AppointmentStatus })
  @IsEnum(AppointmentStatus)
  @IsOptional()
  status?: AppointmentStatus;

  @ApiPropertyOptional({ description: 'Add-ons for the service' })
  @IsOptional()
  addons?: Array<{
    addonId: string;
    quantity: number;
  }>;

  @ApiPropertyOptional({ description: 'Discount information' })
  @IsOptional()
  discount?: {
    type: 'percentage' | 'fixed';
    value: number;
    code?: string;
    reason: string;
  };

  @ApiPropertyOptional({ description: 'Cancellation reason' })
  @IsString()
  @IsOptional()
  cancellationReason?: string;

  @ApiPropertyOptional({ description: 'Commission rate override (percentage) - admin/owner only' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  commissionRate?: number;

  @ApiPropertyOptional({ description: 'Services for multi-service appointments' })
  @IsOptional()
  services?: Array<{
    serviceId: string;
    professionalId?: string | null;
    isParallel?: boolean;
  }>;
}