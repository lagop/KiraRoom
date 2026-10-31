import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEmail, IsOptional, IsIn, IsDateString, IsArray, IsNotEmpty, ValidateIf } from 'class-validator';
import { ClientStatus, Gender, NifType } from '@prisma/client';
import {
  CLIENT_GENDERS,
  CLIENT_STATUSES,
  CLIENT_TAX_ID_TYPES,
} from '../../../clients/dto/create-client.dto';

/**
 * Every field optional. Optional columns accept null, which empties them
 * (a field emptied in the panel). The name, the status and the language
 * cannot be emptied: null there is a 400.
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

  @ApiProperty({ description: 'Email address', required: false })
  @IsEmail()
  @IsOptional()
  email?: string | null;

  @ApiProperty({ description: 'Phone number', required: false })
  @IsString()
  @IsOptional()
  phone?: string | null;

  @ApiProperty({ description: 'Date of birth', example: '1990-01-01', required: false })
  @IsDateString()
  @IsOptional()
  dateOfBirth?: string | null;

  @ApiProperty({ description: 'Gender', enum: CLIENT_GENDERS, required: false })
  @IsIn(CLIENT_GENDERS)
  @IsOptional()
  gender?: Gender | null;

  @ApiProperty({ description: 'Client status', enum: CLIENT_STATUSES, required: false })
  @ValidateIf((_, v) => v !== undefined)
  @IsIn(CLIENT_STATUSES)
  status?: ClientStatus;

  @ApiProperty({ description: 'Preferred language', example: 'es', required: false })
  @ValidateIf((_, v) => v !== undefined)
  @IsString()
  preferredLanguage?: string;

  @ApiProperty({ description: 'Notes about the client', required: false })
  @IsString()
  @IsOptional()
  notes?: string | null;

  @ApiProperty({ description: 'Client allergies', type: [String], required: false })
  @ValidateIf((_, v) => v !== undefined)
  @IsArray()
  allergies?: string[];

  @ApiProperty({ description: 'Medical conditions', type: [String], required: false })
  @ValidateIf((_, v) => v !== undefined)
  @IsArray()
  medicalConditions?: string[];

  @ApiProperty({ description: 'Client tags', type: [String], required: false })
  @ValidateIf((_, v) => v !== undefined)
  @IsArray()
  tags?: string[];

  @ApiProperty({ description: 'Tax ID (NIF/CIF/NIE checked; passport/other as typed)', required: false })
  @IsString()
  @IsOptional()
  taxId?: string | null;

  @ApiProperty({ description: 'Tax ID type', enum: CLIENT_TAX_ID_TYPES, required: false })
  @IsIn(CLIENT_TAX_ID_TYPES)
  @IsOptional()
  taxIdType?: NifType | null;
}
