import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber, IsBoolean, IsOptional } from 'class-validator';

export class UpdateServiceDto {
  @ApiProperty({ description: 'Service name', required: false })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({ description: 'Service description', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ description: 'Service category', required: false })
  @IsString()
  @IsOptional()
  category?: string;

  @ApiProperty({ description: 'Service duration in minutes', required: false })
  @IsNumber()
  @IsOptional()
  duration?: number;

  @ApiProperty({ description: 'Service price', required: false })
  @IsNumber()
  @IsOptional()
  price?: number;

  @ApiProperty({ description: 'Service currency', required: false })
  @IsString()
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
  @IsNumber()
  @IsOptional()
  maxAdvanceBooking?: number;

  @ApiProperty({ description: 'Min advance booking hours', required: false })
  @IsNumber()
  @IsOptional()
  minAdvanceBooking?: number;

  @ApiProperty({ description: 'Buffer time in minutes', required: false })
  @IsNumber()
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
  @IsNumber()
  @IsOptional()
  depositAmount?: number;

  @ApiProperty({ description: 'Deposit percentage (of total price)', required: false })
  @IsNumber()
  @IsOptional()
  depositPercentage?: number;
}