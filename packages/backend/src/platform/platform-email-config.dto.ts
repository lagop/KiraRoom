import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsInt, IsOptional, IsString, Max, MaxLength, Min } from "class-validator";

/**
 * Each field: a string sets it, null clears it (the server's .env applies
 * again), absent leaves it as it is. The values are checked in
 * PlatformEmailConfigService, which explains in Spanish what is wrong.
 */
export class UpdatePlatformEmailConfigDto {
  @ApiPropertyOptional({ description: "Resend API key (re_...). Write-only." })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  apiKey?: string | null;

  @ApiPropertyOptional({ description: "Sender: notificaciones@kiraroom.com or KiraRoom <notificaciones@kiraroom.com>" })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  from?: string | null;

  @ApiPropertyOptional({ description: "Resend webhook signing secret (whsec_...). Write-only." })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  webhookSecret?: string | null;

  @ApiPropertyOptional({ description: "Emails in a bono de emails (null: not offered)." })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  marketingPackEmails?: number | null;

  @ApiPropertyOptional({ description: "Price of a bono de emails in cents, before VAT (null: not offered)." })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(100_000_000)
  marketingPackPriceCents?: number | null;
}

/** Body of POST /platform/email-config/test: typed values to test without saving them. */
export class TestPlatformEmailDto {
  @ApiPropertyOptional({ description: "Resend API key to test instead of the one in force. Never stored." })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  apiKey?: string;

  @ApiPropertyOptional({ description: "Sender to test instead of the one in force." })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  from?: string;
}
