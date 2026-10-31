import { ApiProperty } from '@nestjs/swagger';
import {
  IsString,
  IsEmail,
  IsOptional,
  IsDateString,
  IsIn,
  IsNotEmpty,
} from 'class-validator';
import { ClientStatus, Gender, NifType } from '@prisma/client';

/** The enums as the database has them: anything else is a 400, not a 500. */
export const CLIENT_STATUSES = Object.values(ClientStatus);
export const CLIENT_GENDERS = Object.values(Gender);
export const CLIENT_TAX_ID_TYPES = Object.values(NifType);

export class CreateClientDto {
  /** Ignored: the controller sets it from the caller's token. */
  @ApiProperty({ description: 'Ignored; the tenant comes from the token', required: false })
  @IsString()
  @IsOptional()
  tenantId?: string;

  @ApiProperty({ description: 'First name' })
  @IsString()
  @IsNotEmpty()
  firstName: string;

  @ApiProperty({ description: 'Last name' })
  @IsString()
  @IsNotEmpty()
  lastName: string;

  @ApiProperty({ description: 'Email address', required: false })
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

  @ApiProperty({
    description: 'Client status (defaults to active; staff always create active clients)',
    required: false,
    enum: CLIENT_STATUSES,
  })
  @IsIn(CLIENT_STATUSES)
  @IsOptional()
  status?: ClientStatus;

  @ApiProperty({
    description:
      'Tax ID. NIF/CIF/NIE are checked and normalized (400 when malformed); passport/other are stored as typed.',
    required: false,
  })
  @IsString()
  @IsOptional()
  taxId?: string | null;

  @ApiProperty({
    description: 'Classification of taxId. AEAT rejects mismatched values.',
    required: false,
    enum: CLIENT_TAX_ID_TYPES,
  })
  @IsOptional()
  @IsIn(CLIENT_TAX_ID_TYPES)
  taxIdType?: NifType | null;
}
