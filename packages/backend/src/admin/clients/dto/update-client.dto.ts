import { ApiProperty, PartialType } from '@nestjs/swagger';
import { CreateClientDto } from './create-client.dto';
import { IsString, IsEmail, IsOptional, IsEnum, IsDateString, IsArray } from 'class-validator';
import { ClientStatus, Gender } from '@prisma/client';

export class UpdateClientDto extends PartialType(CreateClientDto) {
  @ApiProperty({ description: 'First name', example: 'John', required: false })
  @IsString()
  @IsOptional()
  firstName?: string;

  @ApiProperty({ description: 'Last name', example: 'Doe', required: false })
  @IsString()
  @IsOptional()
  lastName?: string;

  @ApiProperty({ description: 'Email address', example: 'john.doe@example.com', required: false })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiProperty({ description: 'Phone number', example: '+1234567890', required: false })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiProperty({ description: 'Date of birth', example: '1990-01-01', required: false })
  @IsDateString()
  @IsOptional()
  dateOfBirth?: Date;

  @ApiProperty({ description: 'Gender', enum: Gender, example: Gender.male, required: false })
  @IsEnum(Gender)
  @IsOptional()
  gender?: Gender;

  @ApiProperty({ description: 'Client status', enum: ClientStatus, example: ClientStatus.active, required: false })
  @IsEnum(ClientStatus)
  @IsOptional()
  status?: ClientStatus;

  @ApiProperty({ description: 'Preferred language', example: 'es', required: false })
  @IsString()
  @IsOptional()
  preferredLanguage?: string;

  @ApiProperty({ description: 'Notes about the client', example: 'VIP client', required: false })
  @IsString()
  @IsOptional()
  notes?: string;

  @ApiProperty({ description: 'Client allergies', type: [String], example: ['nuts', 'latex'], required: false })
  @IsArray()
  @IsOptional()
  allergies?: string[];

  @ApiProperty({ description: 'Medical conditions', type: [String], example: ['asthma'], required: false })
  @IsArray()
  @IsOptional()
  medicalConditions?: string[];

  @ApiProperty({ description: 'Client tags', type: [String], example: ['vip', 'regular'], required: false })
  @IsArray()
  @IsOptional()
  tags?: string[];
}