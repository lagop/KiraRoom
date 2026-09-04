import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEmail, IsOptional, IsDateString, IsArray, IsNumber, IsBoolean, IsUUID } from 'class-validator';

export class CreateProfessionalDto {
  @ApiProperty({ description: 'Tenant ID', example: 'tenant-uuid-here' })
  @IsString()
  tenantId: string;

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

  @ApiProperty({ description: 'Commission rate', example: 0.5 })
  @IsNumber()
  @IsOptional()
  commissionRate?: number;

  @ApiProperty({ description: 'Hire date', example: '2020-01-01' })
  @IsDateString()
  @IsOptional()
  hireDate?: Date;

  @ApiProperty({ description: 'Working hours', type: 'array', example: [{ day: 'monday', start: '09:00', end: '18:00' }] })
  @IsArray()
  @IsOptional()
  workingHours?: any[];

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