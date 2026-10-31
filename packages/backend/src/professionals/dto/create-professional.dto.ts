import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEmail, IsBoolean, IsOptional, IsNotEmpty, IsNumber } from 'class-validator';
import { IsWorkingHours } from '../working-hours-input';
import { CommissionRateInput } from '../optional-fields';

/**
 * No `tenantId` here on purpose: the tenant comes from the caller's token.
 * The dashboard sent placeholders ('default-tenant', 'default'), which the
 * tenant scope rejected with a 403. See services/dto/create-service.dto.ts.
 */
export class CreateProfessionalDto {
  @ApiProperty({ description: 'First name' })
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({ description: 'Last name' })
  @IsString()
  @IsNotEmpty()
  lastName: string;

  @ApiProperty({ description: 'Email address' })
  @IsEmail()
  @IsNotEmpty()
  email: string;

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