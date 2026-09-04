import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsEmail, IsOptional, IsEnum, IsDateString, IsArray } from 'class-validator';
import { ClientStatus, Gender } from '@prisma/client';

export class CreateClientDto {
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

  @ApiProperty({ description: 'Date of birth', example: '1990-01-01' })
  @IsDateString()
  @IsOptional()
  dateOfBirth?: Date;

  @ApiProperty({ description: 'Gender', enum: Gender, example: Gender.male })
  @IsEnum(Gender)
  @IsOptional()
  gender?: Gender;

  @ApiProperty({ description: 'Client status', enum: ClientStatus, example: ClientStatus.active })
  @IsEnum(ClientStatus)
  @IsOptional()
  status?: ClientStatus;

  @ApiProperty({ description: 'Preferred language', example: 'es' })
  @IsString()
  @IsOptional()
  preferredLanguage?: string;

  @ApiProperty({ description: 'Notes about the client', example: 'VIP client' })
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiProperty({ description: 'Client allergies', type: [String], example: ['nuts', 'latex'] })
  @IsArray()
  @IsOptional()
  allergies?: string[];

  @ApiProperty({ description: 'Medical conditions', type: [String], example: ['asthma'] })
  @IsArray()
  @IsOptional()
  medicalConditions?: string[];

  @ApiProperty({ description: 'Client tags', type: [String], example: ['vip', 'regular'] })
  @IsArray()
  @IsOptional()
  tags?: string[];
}