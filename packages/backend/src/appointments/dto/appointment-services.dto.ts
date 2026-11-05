import { IsUUID, IsString, IsDateString, IsOptional, IsEnum, IsBoolean, IsNumber, IsIn, IsInt, Min, Max } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AppointmentServiceType, AppointmentServiceStatus } from '@prisma/client';

export { AppointmentServiceType, AppointmentServiceStatus };

export class CreateAppointmentServiceDto {
  @ApiProperty({ description: 'Appointment ID' })
  @IsUUID()
  appointmentId!: string;

  @ApiProperty({ description: 'Service ID' })
  @IsUUID()
  serviceId!: string;

  @ApiPropertyOptional({ description: 'Professional ID (NULL for processing time)' })
  @IsUUID()
  @IsOptional()
  professionalId?: string;

  @ApiPropertyOptional({ description: 'Scheduled start time' })
  @IsDateString()
  @IsOptional()
  scheduledStart?: Date;

  @ApiPropertyOptional({ description: 'Scheduled end time' })
  @IsDateString()
  @IsOptional()
  scheduledEnd?: Date;

  @ApiPropertyOptional({ description: 'Type: active, processing, or continuation', enum: AppointmentServiceType })
  @IsEnum(AppointmentServiceType)
  @IsOptional()
  type?: AppointmentServiceType;

  @ApiPropertyOptional({ description: 'Is this a parallel service (e.g., manicure + pedicure)' })
  @IsBoolean()
  @IsOptional()
  isParallel?: boolean;

  @ApiPropertyOptional({ description: 'Order within the appointment' })
  @IsNumber()
  @IsOptional()
  order?: number;

  @ApiPropertyOptional({ description: 'Notes' })
  @IsString()
  @IsOptional()
  notes?: string;
}

export class UpdateAppointmentServiceDto {
  @ApiPropertyOptional({ description: 'Professional ID' })
  @IsUUID()
  @IsOptional()
  professionalId?: string;

  @ApiPropertyOptional({ description: 'Scheduled start time' })
  @IsDateString()
  @IsOptional()
  scheduledStart?: Date;

  @ApiPropertyOptional({ description: 'Scheduled end time' })
  @IsDateString()
  @IsOptional()
  scheduledEnd?: Date;

  @ApiPropertyOptional({ description: 'Actual start time' })
  @IsDateString()
  @IsOptional()
  actualStart?: Date;

  @ApiPropertyOptional({ description: 'Actual end time' })
  @IsDateString()
  @IsOptional()
  actualEnd?: Date;

  @ApiPropertyOptional({ description: 'Type: active, processing, or continuation', enum: AppointmentServiceType })
  @IsEnum(AppointmentServiceType)
  @IsOptional()
  type?: AppointmentServiceType;

  @ApiPropertyOptional({ description: 'Is this a parallel service' })
  @IsBoolean()
  @IsOptional()
  isParallel?: boolean;

  @ApiPropertyOptional({ description: 'Order within the appointment' })
  @IsNumber()
  @IsOptional()
  order?: number;

  @ApiPropertyOptional({ description: 'Status', enum: AppointmentServiceStatus })
  @IsEnum(AppointmentServiceStatus)
  @IsOptional()
  status?: AppointmentServiceStatus;

  @ApiPropertyOptional({ description: 'Notes' })
  @IsString()
  @IsOptional()
  notes?: string;
}

export class AppointmentServiceFiltersDto {
  @ApiPropertyOptional({ description: 'Appointment ID' })
  @IsUUID()
  @IsOptional()
  appointmentId?: string;

  @ApiPropertyOptional({ description: 'Professional ID' })
  @IsUUID()
  @IsOptional()
  professionalId?: string;

  @ApiPropertyOptional({ description: 'Service ID' })
  @IsUUID()
  @IsOptional()
  serviceId?: string;

  @ApiPropertyOptional({ description: 'Type', enum: AppointmentServiceType })
  @IsEnum(AppointmentServiceType)
  @IsOptional()
  type?: AppointmentServiceType;

  @ApiPropertyOptional({ description: 'Status', enum: AppointmentServiceStatus })
  @IsEnum(AppointmentServiceStatus)
  @IsOptional()
  status?: AppointmentServiceStatus;

  @ApiPropertyOptional({ description: 'Start date filter' })
  @IsDateString()
  @IsOptional()
  startDate?: Date;

  @ApiPropertyOptional({ description: 'End date filter' })
  @IsDateString()
  @IsOptional()
  endDate?: Date;
}

/** Dragging one service of a multi-service appointment (see visit-move.ts). */
export class MoveVisitServiceDto {
  @ApiProperty({ enum: ['visit', 'service'], description: 'Move the whole visit, or only this service' })
  @IsIn(['visit', 'service'])
  scope!: 'visit' | 'service';

  /**
   * How far the dragged service moves. A difference, not a clock time: the
   * calendar draws in the browser's time zone and the server reckons in the
   * salon's, and a salon in the Canaries with Madrid time set moved visits
   * by two hours instead of one.
   */
  @ApiProperty({ description: 'Minutes the dragged service moves (negative: earlier)' })
  @IsInt()
  @Min(-24 * 60)
  @Max(24 * 60)
  minutesDelta!: number;

  @ApiPropertyOptional({ description: 'Professional of the column it was dropped on' })
  @IsOptional()
  @IsUUID()
  professionalId?: string;
}
