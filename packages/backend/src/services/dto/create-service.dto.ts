import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsNumber, IsBoolean, IsOptional, IsNotEmpty } from 'class-validator';

export class CreateServiceDto {
  @ApiProperty({ description: 'Tenant ID' })
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ description: 'Service name' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ description: 'Service description', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ description: 'Service category' })
  @IsString()
  @IsNotEmpty()
  category: string;

  @ApiProperty({ description: 'Service duration in minutes' })
  @IsNumber()
  @IsNotEmpty()
  duration: number;

  @ApiProperty({ description: 'Service price' })
  @IsNumber()
  @IsNotEmpty()
  price: number;

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