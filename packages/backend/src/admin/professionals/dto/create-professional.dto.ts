import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEmail, IsOptional, IsDateString, IsArray, IsNumber, IsBoolean, IsUUID, Min, Max } from 'class-validator';
import { IsWorkingHours } from '../../../professionals/working-hours-input';

export class CreateProfessionalDto {
  /**
   * Ignored: AdminProfessionalsController sets it from the caller's token.
   * Optional so a body without it validates -- the dashboard no longer sends
   * one, and required here it made every create a 400.
   */
  @ApiProperty({ description: 'Ignored; the tenant comes from the token', required: false })
  @IsString()
  @IsOptional()
  tenantId?: string;

  @ApiProperty({ description: 'First name', example: 'John' })
  @IsString()
  firstName: string;

  @ApiProperty({ description: 'Last name', example: 'Doe' })
  @IsString()
  lastName: string;

  @ApiProperty({ description: 'Email address', example: 'john.doe@example.com' })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiProperty({ description: 'Phone number', example: '+1234567890' })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({ description: 'Profile image URL', example: 'https://example.com/profile-image.jpg' })
  @IsString()
  @IsOptional()
  profileImage?: string;

  @ApiProperty({ description: 'Professional bio', example: 'Experienced hair stylist with 10+ years' })
  @IsString()
  @IsOptional()
  bio?: string;

  @ApiProperty({ description: 'Specialties', type: [String], example: ['haircut', 'coloring'] })
  @IsArray()
  @IsOptional()
  specialties?: string[];

  @ApiProperty({ description: 'Portfolio images', type: [String], example: ['https://example.com/portfolio1.jpg'] })
  @IsArray()
  @IsOptional()
  portfolioImages?: string[];

  @ApiProperty({ description: 'Years of experience', example: 5 })
  @IsNumber()
  @IsOptional()
  yearsExperience?: number;

  @ApiProperty({ description: 'Languages spoken', type: [String], example: ['English', 'Spanish'] })
  @IsArray()
  @IsOptional()
  languages?: string[];

  @ApiProperty({ description: 'Certifications', type: [String], example: ['Certified Colorist'] })
  @IsArray()
  @IsOptional()
  certifications?: string[];

  @ApiProperty({ description: 'Position', example: 'Senior Stylist' })
  @IsString()
  @IsOptional()
  position?: string;

  @ApiProperty({ description: 'Commission rate, a percent (0-100)', example: 40 })
  @IsNumber({}, { message: 'La comisión debe ser un número.' })
  @Min(0, { message: 'La comisión va de 0 a 100 (%).' })
  @Max(100, { message: 'La comisión va de 0 a 100 (%).' })
  @IsOptional()
  commissionRate?: number | null;

  @ApiProperty({ description: 'Hire date', example: '2020-01-01' })
  @IsDateString({}, { message: 'La fecha de alta no es válida.' })
  @IsOptional()
  hireDate?: string;

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

  @ApiProperty({ description: 'Availability schedule', type: 'object', example: {} })
  @IsOptional()
  availability?: any;

  @ApiProperty({ description: 'Professional settings', type: 'object', example: {} })
  @IsOptional()
  settings?: any;

  @ApiProperty({ description: 'Professional statistics', type: 'object', example: {} })
  @IsOptional()
  stats?: any;

  @ApiProperty({ description: 'Associated service IDs', type: [String], example: ['service-uuid-1', 'service-uuid-2'] })
  @IsArray()
  @IsOptional()
  serviceIds?: string[];
}