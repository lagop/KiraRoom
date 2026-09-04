import {
  IsInt,
  IsOptional,
  IsString,
  IsEmail,
  IsUUID,
  IsDateString,
  Min,
  MaxLength,
} from "class-validator";

export class CreateGiftCardDto {
  @IsInt()
  @Min(100)
  initialAmount: number;

  @IsOptional()
  @IsUUID()
  purchasedById?: string;

  @IsOptional()
  @IsUUID()
  recipientId?: string;

  @IsOptional()
  @IsEmail()
  recipientEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  recipientName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;

  @IsOptional()
  @IsDateString()
  expiresAt?: string;
}
