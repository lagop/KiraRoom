import { ApiProperty, PartialType } from '@nestjs/swagger';
import { CreateProfessionalDto } from './create-professional.dto';
import { IsString, IsEmail, IsOptional, IsDateString, IsArray, IsNumber, IsBoolean, IsUUID, IsNotEmpty, ValidateNested, Min, Max } from 'class-validator';
import { IsWorkingHours } from '../../../professionals/working-hours-input';
import { EmptyAsNull } from '../../../professionals/optional-fields';
import { Type } from 'class-transformer';

export class UpdateProfessionalDto extends PartialType(CreateProfessionalDto) {
  @ApiProperty({ description: 'First name', example: 'John', required: false })
  @IsString()
  @IsOptional()
  firstName?: string;

  @ApiProperty({ description: 'Last name', example: 'Doe', required: false })
  @IsString()
  @IsOptional()
  lastName?: string;

  @ApiProperty({ description: 'Email address (also their panel login, if they have one)', example: 'john.doe@example.com', required: false })
  @IsEmail({}, { message: 'El email no es válido.' })
  @IsOptional()
  email?: string;

  @ApiProperty({ description: 'Phone number', example: '+1234567890', required: false })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({ description: 'Profile image URL', example: 'https://example.com/profile-image.jpg', required: false })
  @IsString()
  @IsOptional()
  profileImage?: string;

  @ApiProperty({ description: 'Professional bio', example: 'Experienced hair stylist with 10+ years', required: false })
  @IsString()
  @IsOptional()
  bio?: string;

  @ApiProperty({ description: 'Specialties', type: [String], example: ['haircut', 'coloring'], required: false })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  specialties?: string[];

  @ApiProperty({ description: 'Portfolio images', type: [String], example: ['https://example.com/portfolio1.jpg'], required: false })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  portfolioImages?: string[];

  @ApiProperty({ description: 'Years of experience', example: 5, required: false })
  @IsNumber()
  @IsOptional()
  yearsExperience?: number;

  @ApiProperty({ description: 'Languages spoken', type: [String], example: ['English', 'Spanish'], required: false })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  languages?: string[];

  @ApiProperty({ description: 'Certifications', type: [String], example: ['Certified Colorist'], required: false })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  certifications?: string[];

  @ApiProperty({ description: 'Position', example: 'Senior Stylist', required: false })
  @IsString()
  @IsOptional()
  position?: string;

  @ApiProperty({ description: 'Commission rate, a percent (0-100); null clears it', example: 40, required: false })
  @IsNumber({}, { message: 'La comisión debe ser un número.' })
  @Min(0, { message: 'La comisión va de 0 a 100 (%).' })
  @Max(100, { message: 'La comisión va de 0 a 100 (%).' })
  @IsOptional()
  commissionRate?: number | null;

  @ApiProperty({ description: 'Hire date', example: '2020-01-01', required: false })
  @IsDateString({}, { message: 'La fecha de alta no es válida.' })
  @IsOptional()
  hireDate?: string;

  @ApiProperty({ description: 'Termination date; null or "" clears it', example: '2026-12-31', required: false })
  @EmptyAsNull()
  @IsDateString({}, { message: 'La fecha de baja no es válida.' })
  @IsOptional()
  terminationDate?: string | null;

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

  @ApiProperty({ description: 'Availability schedule', type: 'object', example: {}, required: false })
  @IsOptional()
  availability?: any;

  @ApiProperty({ description: 'Professional settings', type: 'object', example: {}, required: false })
  @IsOptional()
  settings?: any;

  @ApiProperty({ description: 'Professional statistics', type: 'object', example: {}, required: false })
  @IsOptional()
  stats?: any;

  @ApiProperty({ description: 'Whether the professional is active', example: true, required: false })
  @IsBoolean()
  @IsOptional()
  isActive?: boolean;

  @ApiProperty({ description: 'Associated service IDs', type: [String], example: ['service-uuid-1', 'service-uuid-2'], required: false })
  @IsArray()
  @IsUUID('4', { each: true })
  @IsOptional()
  serviceIds?: string[];
}