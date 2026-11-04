import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { NormalizeEmail } from '../email-normalize';

export class LoginDto {
  @ApiProperty({ description: 'Email address (trimmed and lower-cased)', example: 'owner@example.com' })
  @NormalizeEmail()
  @IsEmail({}, { message: 'Escribe un email válido.' })
  @MaxLength(254, { message: 'El email es demasiado largo.' })
  email: string;

  @ApiProperty({ description: 'Password', example: 'securePassword123' })
  @IsString({ message: 'Escribe la contraseña.' })
  @MinLength(8, { message: 'Email o contraseña incorrectos.' })
  @MaxLength(200, { message: 'Email o contraseña incorrectos.' })
  password: string;

  /**
   * The salon whose site the client is signing in on. A client's email is
   * unique per salon, not globally, so without this a client of two salons
   * was signed into whichever row the database returned first -- possibly
   * the other salon, on this salon's site.
   */
  @ApiProperty({ required: false, description: 'Salon slug (client sign-in on a salon site)' })
  @IsOptional()
  @IsString()
  tenantSlug?: string;

  /** Cloudflare Turnstile response: asked for after 3 failed sign-ins. */
  @ApiProperty({ required: false, description: 'Cloudflare Turnstile token (after repeated failures)' })
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  turnstileToken?: string;
}
