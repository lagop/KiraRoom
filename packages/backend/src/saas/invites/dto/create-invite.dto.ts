import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import { IsEmail, IsEnum, IsIn, IsOptional, IsString, MaxLength } from "class-validator";
import { NormalizeEmail } from "../../../auth/email-normalize";
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
  @NormalizeEmail()
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

  /**
   * The invite creates a salon and its first user, who is its owner. Any
   * role used to be accepted, saas_owner included: a slip in the console
   * would have handed platform-wide permissions to the invited person. The
   * console sends no role at all.
   */
  @ApiPropertyOptional({ enum: ["owner"], default: "owner" })
  @IsOptional()
  @IsIn([UserRole.owner], { message: "Una invitación solo puede crear la cuenta de la dueña del salón (owner)." })
  role?: UserRole;
}