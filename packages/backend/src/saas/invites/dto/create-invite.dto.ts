import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsEnum, IsOptional, IsString, MaxLength } from "class-validator";
import { SubscriptionPlan, UserRole } from "@prisma/client";

/**
 * Body for `POST /saas/tenants/invite`.
 *
 * The SaaS admin fills in { email, tenantName, plan } (and optionally
 * the owner's first/last name and the role to assign) — a magic-link
 * invite is minted and emailed. The Tenant + User rows are NOT created
 * here; they're created when the owner clicks the link and completes
 * the 3-step wizard at `/accept-invite/[token]`.
 */
export class CreateInviteDto {
  @ApiProperty({ example: "owner@glamour-studio.com" })
  @IsEmail()
  email: string;

  @ApiProperty({ example: "Glamour Studio" })
  @IsString()
  @MaxLength(120)
  tenantName: string;

  @ApiProperty({ enum: SubscriptionPlan, example: "esencial" })
  @IsEnum(SubscriptionPlan)
  plan: SubscriptionPlan;

  @ApiPropertyOptional({ example: "María" })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  firstName?: string;

  @ApiPropertyOptional({ example: "García" })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  lastName?: string;

  @ApiPropertyOptional({ enum: UserRole, default: "owner" })
  @IsOptional()
  @IsEnum(UserRole)
  role?: UserRole;
}