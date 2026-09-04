import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsOptional, IsIn, IsUrl } from "class-validator";

export class UpdateTenantDto {
  @ApiPropertyOptional({ description: "Tenant name" })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiPropertyOptional({ description: "Tenant description" })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: "Tenant language", enum: ["es", "en"] })
  @IsString()
  @IsIn(["es", "en"])
  @IsOptional()
  language?: string;

  @ApiPropertyOptional({ description: "Tenant currency" })
  @IsString()
  @IsOptional()
  currency?: string;

  @ApiPropertyOptional({ description: "Tenant timezone" })
  @IsString()
  @IsOptional()
  timezone?: string;

  @ApiPropertyOptional({ description: "Tenant date format" })
  @IsString()
  @IsOptional()
  dateFormat?: string;

  @ApiPropertyOptional({ description: "Tenant time format" })
  @IsString()
  @IsOptional()
  timeFormat?: string;

  // ─── Identity fields used by the onboarding wizard (workspace_business) ───
  // These are persisted on Tenant and read by the `hasBusinessIdentity`
  // detector to mark the linear_required step done. Keep in sync with
  // `prisma/schema.prisma` Tenant model + OnboardingDetectorService.

  @ApiPropertyOptional({ description: "Tenant street address" })
  @IsString()
  @IsOptional()
  street?: string;

  @ApiPropertyOptional({ description: "Tenant city" })
  @IsString()
  @IsOptional()
  city?: string;

  @ApiPropertyOptional({ description: "Tenant phone number" })
  @IsString()
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ description: "Tenant logo URL or data: URL" })
  @IsString()
  @IsOptional()
  logo?: string;

  @ApiPropertyOptional({ description: "Tenant postal code" })
  @IsString()
  @IsOptional()
  postalCode?: string;

  @ApiPropertyOptional({ description: "Tenant state / province" })
  @IsString()
  @IsOptional()
  state?: string;
}
