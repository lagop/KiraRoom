import { IsBoolean, IsDateString, IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateGiftCardDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  /** Last day the card works ("YYYY-MM-DD", salon calendar); `null` removes the expiry. */
  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}
