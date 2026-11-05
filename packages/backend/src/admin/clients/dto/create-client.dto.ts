import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEmail, IsOptional, IsIn, IsDateString, IsArray, IsNotEmpty } from 'class-validator';
import { ClientStatus, Gender, NifType } from '@prisma/client';
import {
  CLIENT_GENDERS,
  CLIENT_STATUSES,
  CLIENT_TAX_ID_TYPES,
} from '../../../clients/dto/create-client.dto';

export class CreateClientDto {
  /** Ignored: the controller sets it from the caller's token. */
  @ApiProperty({ description: 'Ignored; the tenant comes from the token', required: false })
  @IsString()
  @IsOptional()
  tenantId?: string;

  @ApiProperty({ description: 'First name', example: 'Lucía' })
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({ description: 'Last name', example: 'García' })
  @IsString()
  @IsNotEmpty()
  lastName: string;

  @ApiProperty({ description: 'Email address', example: 'lucia@example.com', required: false })
  @IsEmail()
  @IsOptional()
  email?: string | null;

  @ApiProperty({ description: 'Phone number', example: '+34600000000', required: false })
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
  @IsIn(CLIENT_STATUSES)
  @IsOptional()
  status?: ClientStatus;

  @ApiProperty({ description: 'Preferred language', example: 'es', required: false })
  @IsString()
  @IsOptional()
  preferredLanguage?: string;

  @ApiProperty({ description: 'Notes about the client', required: false })
  @IsString()
  @IsOptional()
  notes?: string | null;

  @ApiProperty({ description: 'Client allergies', type: [String], required: false })
  @IsArray()
  @IsOptional()
  allergies?: string[];

  @ApiProperty({ description: 'Medical conditions', type: [String], required: false })
  @IsArray()
  @IsOptional()
  medicalConditions?: string[];

  @ApiProperty({ description: 'Client tags', type: [String], required: false })
  @IsArray()
  @IsOptional()
  tags?: string[];

  @ApiProperty({
    description: 'Tax ID. NIF/CIF/NIE are checked and normalized (400 when malformed); passport/other are stored as typed.',
    required: false,
  })
  @IsString()
  @IsOptional()
  taxId?: string | null;

  @ApiProperty({ description: 'Tax ID type', enum: CLIENT_TAX_ID_TYPES, required: false })
  @IsIn(CLIENT_TAX_ID_TYPES)
  @IsOptional()
  taxIdType?: NifType | null;
}
