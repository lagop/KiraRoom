import { IsUUID, IsString, IsDateString, IsOptional, IsEnum, IsNumber, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AppointmentStatus, PaymentStatus, AppointmentSource, AppointmentLocation } from '@prisma/client';

export class CreateAppointmentDto {
  @ApiProperty({ description: 'Tenant ID for multi-tenant support' })
  @IsUUID()
  tenantId!: string;

  @ApiPropertyOptional({ description: 'Client ID (if client already exists)' })
  @IsUUID()
  @IsOptional()
  clientId?: string;

  @ApiPropertyOptional({ 
    description: 'Client information for new clients',
    example: {
      firstName: 'Juan',
      lastName: 'Pérez',
      email: 'juan@email.com',
      phone: '+34600123456'
    }
  })
  @IsOptional()
  clientInfo?: {
    firstName: string;
    lastName: string;
    email: string;
    phone?: string;
  };

  @ApiProperty({ description: 'Service ID' })
  @IsUUID()
  serviceId!: string;

  @ApiProperty({ description: 'Professional ID' })
  @IsUUID()
  professionalId!: string;

  @ApiProperty({ description: 'Scheduled date', example: '2024-01-15' })
  @IsDateString()
  scheduledDate!: Date;

  @ApiProperty({ description: 'Scheduled time', example: '14:30' })
  @IsString()
  scheduledTime!: string;

  @ApiPropertyOptional({ description: 'Appointment notes' })
  @IsString()
  @IsOptional()
  notes?: string;

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

  @ApiPropertyOptional({ description: 'Payment method', enum: ['card', 'cash', 'deposit'] })
  @IsEnum(['card', 'cash', 'deposit'])
  @IsOptional()
  paymentMethod?: 'card' | 'cash' | 'deposit';

  @ApiPropertyOptional({ description: 'Whether a deposit is required' })
  @IsOptional()
  depositRequired?: boolean;

  @ApiPropertyOptional({ description: 'Deposit amount (in cents)' })
  @IsOptional()
  @IsNumber()
  depositAmount?: number;

  @ApiPropertyOptional({ description: 'Appointment location', enum: ['salon', 'client_home', 'other'] })
  @IsEnum(['salon', 'client_home', 'other'])
  @IsOptional()
  location?: AppointmentLocation;

  @ApiPropertyOptional({ description: 'Address for client home appointments' })
  @IsString()
  @IsOptional()
  address?: string;

  @ApiPropertyOptional({ description: 'Appointment source', enum: ['online', 'phone', 'walk_in', 'staff', 'widget', 'instagram'] })
  @IsEnum(['online', 'phone', 'walk_in', 'staff', 'widget', 'instagram'])
  @IsOptional()
  source?: AppointmentSource;

  @ApiPropertyOptional({ description: 'UTM source for tracking' })
  @IsString()
  @IsOptional()
  utmSource?: string;

  @ApiPropertyOptional({ description: 'UTM medium for tracking' })
  @IsString()
  @IsOptional()
  utmMedium?: string;

  @ApiPropertyOptional({ description: 'UTM campaign for tracking' })
  @IsString()
  @IsOptional()
  utmCampaign?: string;

  @ApiPropertyOptional({ description: 'Commission rate override (percentage) - admin/owner only' })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  commissionRate?: number;
}