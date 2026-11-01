import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEmail, IsBoolean, IsOptional, IsNumber, Min, Max } from 'class-validator';
import { IsWorkingHours } from '../working-hours-input';
import { CommissionRateInput } from '../optional-fields';

export class UpdateProfessionalDto {
  @ApiProperty({ description: 'First name', required: false })
  @IsString()
  @IsOptional()
  firstName?: string;

  @ApiProperty({ description: 'Last name', required: false })
  @IsString()
  @IsOptional()
  lastName?: string;

  @ApiProperty({ description: 'Email address', required: false })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiProperty({ description: 'Phone number', required: false })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({ description: 'Profile image URL', required: false })
  @IsString()
  @IsOptional()
  profileImage?: string;

  @ApiProperty({ description: 'Bio', required: false })
  @IsString()
  @IsOptional()
  bio?: string;

  @ApiProperty({ description: 'Specialties', required: false })
  @IsOptional()
  specialties?: string[];

  @ApiProperty({ description: 'Is active', required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiProperty({ description: 'Is owner', required: false })
  @IsBoolean()
  @IsOptional()
  isOwner?: boolean;

  @ApiProperty({ description: 'Position', required: false })
  @IsString()
  @IsOptional()
  position?: string;

  @ApiProperty({ description: 'Commission rate', required: false })
  @CommissionRateInput()
  @IsOptional()
  @IsNumber({}, { message: 'La comisión debe ser un número.' })
  @Min(0, { message: 'La comisión va de 0 a 100 (%).' })
  @Max(100, { message: 'La comisión va de 0 a 100 (%).' })
  commissionRate?: number | null;

  @ApiProperty({ description: 'Hire date', required: false })
  @IsString()
  @IsOptional()
  hireDate?: string;

  @ApiProperty({ description: 'Termination date', required: false })
  @IsString()
  @IsOptional()
  terminationDate?: string;

  @ApiProperty({
    description: 'Weekly schedule: one entry per shift, several per day for a split shift (max 21). Owners and admins only.',
    required: false,
    example: [
      { day: 'monday', openTime: '10:00', closeTime: '14:00' },
      { day: 'monday', openTime: '17:00', closeTime: '20:00' },
    ],
  })
  @IsOptional()
  @IsWorkingHours()
  workingHours?: Array<{ day: string; openTime: string; closeTime: string }>;

  @ApiProperty({ description: 'Availability', required: false })
  @IsOptional()
  availability?: any;

  @ApiProperty({ description: 'Settings', required: false })
  @IsOptional()
  settings?: any;

  @ApiProperty({ description: 'Stats', required: false })
  @IsOptional()
  stats?: any;
}