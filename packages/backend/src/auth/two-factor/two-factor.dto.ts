import { IsString, Length, MaxLength } from "class-validator";

/** A code from the authenticator app (6 digits) or a recovery code ("k7m2-9qxr"). */
export class TwoFactorCodeDto {
  @IsString()
  @Length(6, 20)
  code!: string;
}

export class TwoFactorVerifyDto extends TwoFactorCodeDto {
  /** The token login answered with instead of a session. */
  @IsString()
  @MaxLength(2000)
  challenge!: string;
}

export class TwoFactorDisableDto extends TwoFactorCodeDto {
  @IsString()
  @MaxLength(200)
  password!: string;
}
