import { IsUUID, IsDateString, IsOptional, IsNumber, Min } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * GET /appointments/available-slots (public). A query string arrives as
 * text and the global ValidationPipe does no implicit conversion
 * (common/validation/global-validation-pipe.ts), so a numeric field needs
 * its @Type: without it the widget's `duration=60` was refused with a 400
 * and the widget never showed a free time.
 */
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

  @ApiPropertyOptional({ description: 'One of the salon\x27s locations: only the professionals who work there' })
  @IsUUID()
  @IsOptional()
  locationId?: string;

  @ApiPropertyOptional({
    description:
      'The booking widget asking for "any professional": only the widget\x27s professionals count, as when it books (findFreeProfessional)',
  })
  @IsUUID()
  @IsOptional()
  widgetInstanceId?: string;

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
  @Type(() => Number)
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
