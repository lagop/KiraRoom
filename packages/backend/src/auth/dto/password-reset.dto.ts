import { IsEmail, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

export class ForgotPasswordDto {
  @IsEmail()
  email!: string;

  /** A client resetting from a salon's site: only that salon's account. */
  @IsOptional()
  @IsString()
  @MaxLength(120)
  tenantSlug?: string;
}

export class ResetPasswordDto {
  @IsString()
  @MinLength(32)
  @MaxLength(128)
  token!: string;

  @IsString()
  @MinLength(8)
  @MaxLength(128)
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
