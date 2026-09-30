import { ApiPropertyOptional } from "@nestjs/swagger";
import { IsString, IsOptional, IsIn, IsUrl, IsEmail, IsInt, Min, Max, Matches, ValidateNested } from "class-validator";
import { Type } from "class-transformer";

/** The salon-wide window getAvailableSlots reads. HH:MM, 24-hour. */
export class OpeningHoursDto {
  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  open: string;

  @Matches(/^([01]\d|2[0-3]):[0-5]\d$/)
  close: string;
}

export class UpdateTenantDto {
  @ApiPropertyOptional({ description: "Public contact email" })
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiPropertyOptional({ description: "Minimum notice to cancel, in hours" })
  @IsInt()
  @Min(0)
  @Max(720)
  @IsOptional()
  minCancelHours?: number;

  @ApiPropertyOptional({ description: "Salon opening window, merged into openingHours" })
  @ValidateNested()
  @Type(() => OpeningHoursDto)
  @IsOptional()
  openingHours?: OpeningHoursDto;

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
