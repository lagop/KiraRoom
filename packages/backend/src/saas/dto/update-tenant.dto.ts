import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsUrl,
  IsNumber,
} from "class-validator";
import { NifType, SubscriptionPlan, SubscriptionStatus } from "@prisma/client";

export class UpdateTenantDto {
  @ApiPropertyOptional({ example: "Glamour Studio" })
  @IsOptional()
  @IsString()
  name?: string;

  @ApiPropertyOptional({ example: "glamour-studio" })
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiPropertyOptional({ example: "Best salon in town" })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  logo?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl()
  coverImage?: string;

  @ApiPropertyOptional({ example: "https://glamourstudio.com" })
  @IsOptional()
  @IsUrl()
  website?: string;

  @ApiPropertyOptional({ example: "contact@glamourstudio.com" })
  @IsOptional()
  @IsString()
  email?: string;

  @ApiPropertyOptional({ example: "+1234567890" })
  @IsOptional()
  @IsString()
  phone?: string;

  @ApiPropertyOptional({ example: "+1234567890" })
  @IsOptional()
  @IsString()
  whatsapp?: string;

  @ApiPropertyOptional({ example: "123 Main Street" })
  @IsOptional()
  @IsString()
  street?: string;

  @ApiPropertyOptional({ example: "Madrid" })
  @IsOptional()
  @IsString()
  city?: string;

  @ApiPropertyOptional({ example: "Madrid" })
  @IsOptional()
  @IsString()
  state?: string;

  @ApiPropertyOptional({ example: "28001" })
  @IsOptional()
  @IsString()
  postalCode?: string;

  @ApiPropertyOptional({ example: "ES" })
  @IsOptional()
  @IsString()
  country?: string;

  @ApiPropertyOptional({ example: "Europe/Madrid" })
  @IsOptional()
  @IsString()
  timezone?: string;

  @ApiPropertyOptional({ example: "EUR" })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({ example: "es" })
  @IsOptional()
  @IsString()
  language?: string;

  @ApiPropertyOptional({ enum: SubscriptionPlan, example: "professional" })
  @IsOptional()
  @IsEnum(SubscriptionPlan)
  plan?: SubscriptionPlan;

  @ApiPropertyOptional({ enum: SubscriptionStatus, example: "active" })
  @IsOptional()
  @IsEnum(SubscriptionStatus)
  subscriptionStatus?: SubscriptionStatus;

  @ApiPropertyOptional({ type: Date })
  @IsOptional()
  currentPeriodStart?: Date;

  @ApiPropertyOptional({ type: Date })
  @IsOptional()
  currentPeriodEnd?: Date;

  @ApiPropertyOptional({ type: Date })
  @IsOptional()
  trialEnd?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  stripeCustomerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  stripeSubscriptionId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isSuspended?: boolean;

  // P2A — Spanish fiscal compliance.

  @ApiPropertyOptional({ example: "B12345678", description: "Spanish tax ID (NIF/CIF/NIE). Required when fiscalMode != 'none'." })
  @IsOptional()
  @IsString()
  taxId?: string;

  @ApiPropertyOptional({
    enum: NifType,
    example: "cif",
    description: "Classification of taxId. AEAT rejects mismatched values.",
  })
  @IsOptional()
  @IsEnum(NifType)
  taxIdType?: NifType;

  @ApiPropertyOptional({
    example: "Glamour Studio S.L.",
    description: "Legal name of the issuing entity. May differ from `name`.",
  })
  @IsOptional()
  @IsString()
  legalName?: string;
}