import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from "class-validator";
import { NormalizeEmail } from "../email-normalize";

export class ForgotPasswordDto {
  @NormalizeEmail()
  @IsEmail({}, { message: "Escribe un email válido." })
  @MaxLength(254, { message: "El email es demasiado largo." })
  email!: string;

  /** A client resetting from a salon's site: only that salon's account. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  tenantSlug?: string;

  /** Cloudflare Turnstile response, when the captcha is configured. */
  @IsOptional()
  @IsString()
  @MaxLength(4096)
  turnstileToken?: string;
}

export class ResetPasswordDto {
  @IsString({ message: "El enlace no es válido o ha caducado. Pide uno nuevo." })
  @MinLength(32, { message: "El enlace no es válido o ha caducado. Pide uno nuevo." })
  @MaxLength(128, { message: "El enlace no es válido o ha caducado. Pide uno nuevo." })
  token!: string;

  @IsString({ message: "Escribe una contraseña." })
  @MinLength(8, { message: "La contraseña debe tener al menos 8 caracteres." })
  @MaxLength(128, { message: "La contraseña es demasiado larga (máximo 128 caracteres)." })
  password!: string;
}

/** PATCH /auth/password: a panel user changing their own password. */
export class ChangeOwnPasswordDto {
  @IsString()
  @MinLength(1, { message: "Escribe tu contraseña actual." })
  @MaxLength(200)
  currentPassword!: string;

  /** Same floor as registration, sign-in and a reset. */
  @IsString()
  @MinLength(8, { message: "La contraseña nueva debe tener al menos 8 caracteres." })
  @MaxLength(128, { message: "La contraseña nueva es demasiado larga (máximo 128 caracteres)." })
  newPassword!: string;
}
