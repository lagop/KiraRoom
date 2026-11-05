import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsEmail,
  IsOptional,
  IsArray,
  IsObject,
  IsIn,
  IsDateString,
  IsNotEmpty,
  ValidateIf,
} from 'class-validator';
import { ClientStatus, Gender, NifType } from '@prisma/client';
import { CLIENT_GENDERS, CLIENT_STATUSES, CLIENT_TAX_ID_TYPES } from './create-client.dto';

/**
 * Optional fields accept null, which empties them (an emptied field in the
 * panel). The name and the status cannot be emptied: null is a 400.
 */
export class UpdateClientDto {
  @ApiProperty({ description: 'First name', required: false })
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  @IsNotEmpty()
  firstName?: string;

  @ApiProperty({ description: 'Last name', required: false })
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  @IsNotEmpty()
  lastName?: string;

  @ApiProperty({ description: 'Email address (owner/admin only)', required: false })
  @IsEmail()
  @IsOptional()
  email?: string | null;

  @ApiProperty({ description: 'Phone number', required: false })
  @IsString()
  @IsOptional()
  phone?: string | null;

  @ApiProperty({ description: 'Date of birth', required: false })
  @IsDateString()
  @IsOptional()
  dateOfBirth?: string | null;

  @ApiProperty({ description: 'Gender', required: false, enum: CLIENT_GENDERS })
  @IsIn(CLIENT_GENDERS)
  @IsOptional()
  gender?: Gender | null;

  @ApiProperty({ description: 'Profile image URL', required: false })
  @IsString()
  @IsOptional()
  profileImage?: string | null;

  @ApiProperty({ description: 'Notes about the client', required: false })
  @IsString()
  @IsOptional()
  notes?: string | null;

  @ApiProperty({ description: 'Preferred language (e.g., en, es, fr)', required: false })
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  preferredLanguage?: string;

  @ApiProperty({ description: 'Preferred service IDs', required: false })
  @ValidateIf((_, v) => v !== undefined)
  @IsArray()
  preferredServices?: string[];

  @ApiProperty({ description: 'Preferred professional IDs', required: false })
  @ValidateIf((_, v) => v !== undefined)
  @IsArray()
  preferredProfessionals?: string[];

  @ApiProperty({ description: 'Preferred times (e.g., morning, afternoon, evening)', required: false, type: [String] })
  @ValidateIf((_, v) => v !== undefined)
  @IsArray()
  preferredTimes?: string[];

  @ApiProperty({ description: 'Communication preferences', required: false })
  @ValidateIf((_, v) => v !== undefined)
  @IsObject()
  communicationPreferences?: Record<string, any>;

  @ApiProperty({ description: 'Client status (owner/admin only)', required: false, enum: CLIENT_STATUSES })
  @ValidateIf((_, v) => v !== undefined)
  @IsIn(CLIENT_STATUSES)
  status?: ClientStatus;

  @ApiProperty({ description: 'Tax ID (NIF/CIF/NIE checked; passport/other as typed)', required: false })
  @IsString()
  @IsOptional()
  taxId?: string | null;

  @ApiProperty({
    description: 'Tax ID type',
    required: false,
    enum: CLIENT_TAX_ID_TYPES,
  })
  @IsOptional()
  @IsIn(CLIENT_TAX_ID_TYPES)
  taxIdType?: NifType | null;
}
