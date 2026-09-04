import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEmail, IsBoolean, IsOptional, IsNotEmpty } from 'class-validator';

export class CreateProfessionalDto {
  @ApiProperty({ description: 'Tenant ID' })
  @IsString()
  @IsNotEmpty()
  tenantId: string;

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
  @IsString()
  @IsOptional()
  commissionRate?: string;

  @ApiProperty({ description: 'Hire date', required: false })
  @IsString()
  @IsOptional()
  hireDate?: string;

  @ApiProperty({ description: 'Termination date', required: false })
  @IsString()
  @IsOptional()
  terminationDate?: string;

  @ApiProperty({ description: 'Working hours', required: false })
  @IsOptional()
  workingHours?: any[];

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