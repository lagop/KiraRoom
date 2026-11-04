import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

/**
 * Each field: a value sets it, null clears it (the server's .env applies
 * again), absent leaves it as it is. Checked in PlatformStripeConfigService,
 * which explains in Spanish what is wrong. (There is no Stripe Tax switch:
 * KiraRoom charges no VAT, decision D6.)
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

  @ApiPropertyOptional({ description: "Webhook signing secret of the secret key's mode (whsec_...). Write-only." })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  webhookSecret?: string | null;

  @ApiPropertyOptional({ description: "Webhook signing secret of the other mode (whsec_...), optional. Write-only." })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  otherWebhookSecret?: string | null;
}

/** Body of POST /platform/stripe-config/test: a typed key to test without saving it. */
export class TestPlatformStripeDto {
  @ApiPropertyOptional({ description: "Secret key to test instead of the one in force. Never stored." })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  secretKey?: string;
}
