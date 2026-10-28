import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsOptional, IsString, MaxLength } from "class-validator";

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
}
