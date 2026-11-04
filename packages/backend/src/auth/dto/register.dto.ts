import { ApiProperty } from '@nestjs/swagger';
import { Equals, IsEmail, IsIn, IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { NormalizeEmail } from '../email-normalize';

export class RegisterDto {
  @ApiProperty({
    description: 'User email address (trimmed and lower-cased)',
    example: 'usuario@ejemplo.com',
  })
  @NormalizeEmail()
  @IsEmail({}, { message: 'Escribe un email válido.' })
  @MaxLength(254, { message: 'El email es demasiado largo.' })
  email!: string;

  @ApiProperty({
    description: 'User password (8 to 128 characters)',
    example: 'password123',
  })
  @IsString({ message: 'Escribe una contraseña.' })
  @MinLength(8, { message: 'La contraseña debe tener al menos 8 caracteres.' })
  @MaxLength(128, { message: 'La contraseña es demasiado larga (máximo 128 caracteres).' })
  password!: string;

  @ApiProperty({
    description: 'Salon or business name',
    example: 'Peluquería Bella Vista',
  })
  @IsString({ message: 'Escribe el nombre del salón.' })
  @IsNotEmpty({ message: 'Escribe el nombre del salón.' })
  @MaxLength(80, { message: 'El nombre del salón es demasiado largo (máximo 80 caracteres).' })
  salonName!: string;

  @ApiProperty({
    description: 'Contact phone number (saved as the salon phone)',
    example: '+34 600 123 456',
  })
  @IsString({ message: 'Escribe un teléfono de contacto.' })
  @IsNotEmpty({ message: 'Escribe un teléfono de contacto.' })
  @MaxLength(30, { message: 'El teléfono es demasiado largo (máximo 30 caracteres).' })
  phone!: string;

  @ApiProperty({
    description: 'Business owner full name',
    example: 'María García',
  })
  @IsString({ message: 'Escribe tu nombre.' })
  @IsNotEmpty({ message: 'Escribe tu nombre.' })
  @MaxLength(80, { message: 'El nombre es demasiado largo (máximo 80 caracteres).' })
  ownerName!: string;

  @ApiProperty({
    description: 'Ignored: a signup always creates the salon owner',
    example: 'owner',
    required: false,
  })
  @IsOptional()
  @IsString()
  role?: string;

  @ApiProperty({
    description: 'Panel language for the owner and the salon (es or en)',
    example: 'es',
    required: false,
  })
  @IsOptional()
  @IsIn(['es', 'en'], { message: 'El idioma tiene que ser español o inglés.' })
  language?: string;

  @ApiProperty({
    description:
      "The sign-up browser's IANA time zone. Taken as the salon's when it is one of SALON_TIMEZONES; otherwise ignored.",
    example: 'Atlantic/Canary',
    required: false,
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  timezone?: string;

  /**
   * The Terms (with the art. 28 GDPR processing agreement in them) and the
   * Privacy Policy. The server used to take `false` as well; the acceptance
   * is now required and recorded (LegalAcceptance).
   */
  @ApiProperty({
    description: 'Accept the terms of service (incl. the art. 28 GDPR processing agreement) and the privacy policy',
    example: true,
  })
  @Equals(true, { message: 'Tienes que aceptar los términos para crear la cuenta.' })
  acceptTerms!: boolean;

  /** Cloudflare Turnstile response, when the captcha is configured. */
  @ApiProperty({ required: false, description: 'Cloudflare Turnstile token' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  turnstileToken?: string;
}
