import { IsInt, IsOptional, IsString, IsUUID, Min, MaxLength } from "class-validator";

export class RedeemGiftCardDto {
  @IsUUID()
  giftCardId: string;

  @IsInt()
  @Min(1)
  amount: number;

  @IsOptional()
  @IsUUID()
  paymentId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}
