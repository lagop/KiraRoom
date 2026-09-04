import { ApiProperty, PartialType } from '@nestjs/swagger';
import { CreateProfessionalDto } from './create-professional.dto';
import { IsString, IsEmail, IsOptional, IsDateString, IsArray, IsNumber, IsBoolean, IsUUID, IsNotEmpty, ValidateNested } from 'class-validator';
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

  @ApiProperty({ description: 'Email address', example: 'john.doe@example.com', required: false })
  @IsString()
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

  @ApiProperty({ description: 'Commission rate', example: 0.5, required: false })
  @IsNumber()
  @IsOptional()
  commissionRate?: number;

  @ApiProperty({ description: 'Hire date', example: '2020-01-01', required: false })
  @IsDateString()
  @IsOptional()
  hireDate?: Date;

  @ApiProperty({ description: 'Working hours', type: 'array', example: [{ day: 'monday', start: '09:00', end: '18:00' }], required: false })
  @IsArray()
  @IsOptional()
  workingHours?: any[];

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