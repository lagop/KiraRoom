import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsEmail,
  IsOptional,
  IsDateString,
  IsEnum,
} from 'class-validator';

export class CreateClientDto {
  @ApiProperty({ description: 'Tenant ID for multi-tenancy' })
  @IsString()
  tenantId: string;

  @ApiProperty({ description: 'First name' })
  @IsString()
  firstName: string;

  @ApiProperty({ description: 'Last name' })
  @IsString()
  lastName: string;

  @ApiProperty({ description: 'Email address', required: false })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiProperty({ description: 'Phone number', required: false })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({ description: 'Date of birth', required: false })
  @IsDateString()
  @IsOptional()
  dateOfBirth?: string;

  @ApiProperty({ description: 'Gender', required: false, enum: ['male', 'female', 'other'] })
  @IsString()
  @IsOptional()
  gender?: 'male' | 'female' | 'other';

  @ApiProperty({ description: 'Profile image URL', required: false })
  @IsString()
  @IsOptional()
  profileImage?: string;

  @ApiProperty({
    description: 'Spanish tax ID (NIF/CIF/NIE). Invalid formats are rejected with 400.',
    required: false,
  })
  @IsString()
  @IsOptional()
  taxId?: string;

  @ApiProperty({
    description: 'Classification of taxId. AEAT rejects mismatched values.',
    required: false,
    enum: ['nif', 'cif', 'nie', 'passport', 'other'],
  })
  @IsOptional()
  @IsEnum(['nif', 'cif', 'nie', 'passport', 'other'])
  taxIdType?: 'nif' | 'cif' | 'nie' | 'passport' | 'other';
}
