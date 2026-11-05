import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsEmail,
  IsUUID,
  IsDateString,
  Max,
  Min,
  MaxLength,
} from "class-validator";

export class CreateGiftCardDto {
  /** Cents: 1 € to 10.000 €. */
  @IsInt()
  @Min(100)
  @Max(1_000_000)
  initialAmount: number;

  @IsOptional()
  @IsUUID()
  purchasedById?: string;

  @IsOptional()
  @IsUUID()
  recipientId?: string;

  @IsOptional()
  @IsEmail()
  @MaxLength(254)
  recipientEmail?: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  recipientName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  message?: string;

  /**
   * Last day the card works ("YYYY-MM-DD", salon calendar). Left out: two
   * years from today. `null`: the card never expires.
   */
  @IsOptional()
  @IsDateString()
  expiresAt?: string | null;

  /** Email the card to `recipientEmail` (default: yes, when there is one). */
  @IsOptional()
  @IsBoolean()
  sendEmail?: boolean;
}
