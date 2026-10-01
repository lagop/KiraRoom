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
