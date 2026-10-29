import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsBoolean, IsOptional, IsString, MaxLength } from "class-validator";

/**
 * Each field: a value sets it, null clears it (the server's .env applies
 * again), absent leaves it as it is. Checked in PlatformStripeConfigService,
 * which explains in Spanish what is wrong.
 */
export class UpdatePlatformStripeConfigDto {
  @ApiPropertyOptional({ description: "Secret key (sk_test_... or sk_live_...). Write-only." })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  secretKey?: string | null;

  @ApiPropertyOptional({ description: "Publishable key (pk_test_... or pk_live_...)." })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  publishableKey?: string | null;

  @ApiPropertyOptional({ description: "Webhook signing secret (whsec_...). Write-only." })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  webhookSecret?: string | null;

  @ApiPropertyOptional({ description: "Stripe Tax on checkouts (VAT and the customer's tax id)." })
  @IsOptional()
  @IsBoolean()
  taxEnabled?: boolean | null;
}
