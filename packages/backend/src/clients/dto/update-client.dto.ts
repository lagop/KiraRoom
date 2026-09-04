import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsEmail,
  IsOptional,
  IsArray,
  IsObject,
  IsEnum,
} from 'class-validator';

export class UpdateClientDto {
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

  @ApiProperty({ description: 'Preferred language (e.g., en, es, fr)', required: false })
  @IsString()
  @IsOptional()
  preferredLanguage?: string;

  @ApiProperty({ description: 'Preferred service IDs', required: false })
  @IsArray()
  @IsOptional()
  preferredServices?: string[];

  @ApiProperty({ description: 'Preferred professional IDs', required: false })
  @IsArray()
  @IsOptional()
  preferredProfessionals?: string[];

  @ApiProperty({ description: 'Preferred times (e.g., morning, afternoon, evening)', required: false, type: [String] })
  @IsArray()
  @IsOptional()
  preferredTimes?: string[];

  @ApiProperty({ description: 'Communication preferences', required: false })
  @IsObject()
  @IsOptional()
  communicationPreferences?: Record<string, any>;

  @ApiProperty({ description: 'Client status', required: false })
  @IsString()
  @IsOptional()
  status?: 'active' | 'inactive' | 'blocked';

  @ApiProperty({ description: 'Spanish tax ID (NIF/CIF/NIE)', required: false })
  @IsString()
  @IsOptional()
  taxId?: string;

  @ApiProperty({
    description: 'Tax ID type',
    required: false,
    enum: ['nif', 'cif', 'nie', 'passport', 'other'],
  })
  @IsOptional()
  @IsEnum(['nif', 'cif', 'nie', 'passport', 'other'])
  taxIdType?: 'nif' | 'cif' | 'nie' | 'passport' | 'other';
}
