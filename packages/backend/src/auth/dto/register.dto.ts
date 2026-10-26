import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, IsOptional, MinLength, IsBoolean } from 'class-validator';

export class RegisterDto {
  @ApiProperty({
    description: 'User email address',
    example: 'usuario@ejemplo.com',
  })
  @IsEmail()
  email!: string;

  @ApiProperty({
    description: 'User password (minimum 8 characters)',
    example: 'password123',
  })
  @IsString()
  @MinLength(8)
  password!: string;

  @ApiProperty({
    description: 'Salon or business name',
    example: 'Peluquería Bella Vista',
  })
  @IsString()
  salonName!: string;

  @ApiProperty({
    description: 'Contact phone number',
    example: '+34 600 123 456',
  })
  @IsString()
  phone!: string;

  @ApiProperty({
    description: 'Business owner full name',
    example: 'María García',
  })
  @IsString()
  ownerName!: string;

  @ApiProperty({
    description: 'User role in the system',
    example: 'owner',
    required: false,
  })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiProperty({
    description: 'User preferred language',
    example: 'es',
    required: false,
  })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiProperty({
    description:
      "The sign-up browser's IANA time zone. Taken as the salon's when it is one of SALON_TIMEZONES; otherwise ignored.",
    example: 'Atlantic/Canary',
    required: false,
  })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiProperty({
    description: 'Accept terms and conditions',
    example: true,
  })
  @IsBoolean()
  acceptTerms!: boolean;
}