import { IsUUID, IsDateString, IsOptional, IsNumber, Min, IsArray } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AvailableSlotsDto {
  @ApiProperty({ description: 'Tenant ID for multi-tenant support' })
  @IsUUID()
  tenantId!: string;

  @ApiPropertyOptional({ description: 'Professional ID to filter slots (single)' })
  @IsUUID()
  @IsOptional()
  professionalId?: string;

  @ApiPropertyOptional({ description: 'Professional IDs for multi-professional scheduling (comma-separated)' })
  @IsOptional()
  professionalIds?: string;

  @ApiPropertyOptional({ description: 'Service ID to filter slots' })
  @IsOptional()
  serviceId?: string;

  @ApiProperty({ description: 'Date to fetch available slots for', example: '2024-01-15' })
  @IsDateString()
  date!: Date;

  @ApiPropertyOptional({ 
    description: 'Duration of the appointment in minutes',
    example: 60,
    default: 60
  })
  @IsNumber()
  @Min(1)
  @IsOptional()
  duration?: number;
}

export class AvailableSlot {
  @ApiProperty({ description: 'Available time slot', example: '14:30' })
  time!: string;

  @ApiProperty({ description: 'Whether the slot is available', default: true })
  isAvailable!: boolean;

  @ApiPropertyOptional({ description: 'Professional ID for this slot' })
  professionalId?: string;

  @ApiPropertyOptional({ description: 'Service ID for this slot' })
  serviceId?: string;
}