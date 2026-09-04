import { IsBoolean, IsDateString, IsOptional, IsString, MaxLength } from "class-validator";

export class UpdateGiftCardDto {
  @IsOptional()
  @IsBoolean()
  isActive?: boolean;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;
}
