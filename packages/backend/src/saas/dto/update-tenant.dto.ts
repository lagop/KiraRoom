import { ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  IsEnum,
  IsBoolean,
  IsUrl,
  IsEmail,
  IsDate,
} from "class-validator";
import { Type } from "class-transformer";
import { EmptyStringToUndefined } from "../../common/dto/empty-to-undefined";
import { CONSOLE_DTO_MESSAGES as MSG } from "./console-dto-messages";
import { NifType, SubscriptionPlan, SubscriptionStatus } from "@prisma/client";

export class UpdateTenantDto {
  @ApiPropertyOptional({ example: "Glamour Studio" })
  @IsOptional()
  @IsString({ message: MSG.text("nombre del salón") })
  name?: string;

  @ApiPropertyOptional({ example: "glamour-studio" })
  @IsOptional()
  @IsString({ message: MSG.text("dirección web") })
  slug?: string;

  @ApiPropertyOptional({ example: "Best salon in town" })
  @IsOptional()
  @IsString({ message: MSG.text("descripción") })
  description?: string;

  @ApiPropertyOptional()
  @EmptyStringToUndefined()
  @IsOptional()
  @IsUrl({}, { message: MSG.url("logo") })
  logo?: string;

  @ApiPropertyOptional()
  @EmptyStringToUndefined()
  @IsOptional()
  @IsUrl({}, { message: MSG.url("imagen de portada") })
  coverImage?: string;

  @ApiPropertyOptional({ example: "https://glamourstudio.com" })
  @EmptyStringToUndefined()
  @IsOptional()
  @IsUrl({}, { message: MSG.url("web") })
  website?: string;

  @ApiPropertyOptional({ example: "contact@glamourstudio.com" })
  @EmptyStringToUndefined()
  @IsOptional()
  @IsEmail({}, { message: "El email del salón no es válido." })
  email?: string;

  @ApiPropertyOptional({ example: "+1234567890" })
  @IsOptional()
  @IsString({ message: MSG.text("teléfono") })
  phone?: string;

  @ApiPropertyOptional({ example: "+1234567890" })
  @IsOptional()
  @IsString({ message: MSG.text("WhatsApp") })
  whatsapp?: string;

  @ApiPropertyOptional({ example: "123 Main Street" })
  @IsOptional()
  @IsString({ message: MSG.text("dirección") })
  street?: string;

  @ApiPropertyOptional({ example: "Madrid" })
  @IsOptional()
  @IsString({ message: MSG.text("ciudad") })
  city?: string;

  @ApiPropertyOptional({ example: "Madrid" })
  @IsOptional()
  @IsString({ message: MSG.text("provincia") })
  state?: string;

  @ApiPropertyOptional({ example: "28001" })
  @IsOptional()
  @IsString({ message: MSG.text("código postal") })
  postalCode?: string;

  @ApiPropertyOptional({ example: "ES" })
  @IsOptional()
  @IsString({ message: MSG.text("país") })
  country?: string;

  @ApiPropertyOptional({ example: "Europe/Madrid" })
  @IsOptional()
  @IsString({ message: MSG.text("zona horaria") })
  timezone?: string;

  @ApiPropertyOptional({ example: "EUR" })
  @IsOptional()
  @IsString({ message: MSG.text("moneda") })
  currency?: string;

  @ApiPropertyOptional({ example: "es" })
  @IsOptional()
  @IsString({ message: MSG.text("idioma") })
  language?: string;

  @ApiPropertyOptional({ enum: SubscriptionPlan, example: "professional" })
  @IsOptional()
  @IsEnum(SubscriptionPlan, { message: MSG.plan })
  plan?: SubscriptionPlan;

  @ApiPropertyOptional({ enum: SubscriptionStatus, example: "active" })
  @IsOptional()
  @IsEnum(SubscriptionStatus, { message: MSG.status })
  subscriptionStatus?: SubscriptionStatus;

  @ApiPropertyOptional({ type: Date })
  @IsOptional()
  @Type(() => Date)
  @IsDate({ message: MSG.date("inicio del periodo") })
  currentPeriodStart?: Date;

  @ApiPropertyOptional({ type: Date })
  @IsOptional()
  @Type(() => Date)
  @IsDate({ message: MSG.date("fin del periodo") })
  currentPeriodEnd?: Date;

  @ApiPropertyOptional({ type: Date })
  @IsOptional()
  @Type(() => Date)
  @IsDate({ message: MSG.date("fin de la prueba") })
  trialEnd?: Date;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: MSG.text("cliente de Stripe") })
  stripeCustomerId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString({ message: MSG.text("suscripción de Stripe") })
  stripeSubscriptionId?: string;

  /**
   * "Dirección de la plataforma" (audit 8 D7): lets a new address use the
   * platform's words or brand names. Audit-logged. Never stored.
   */
  @ApiPropertyOptional({ description: "The new slug is a platform address (platform words allowed)" })
  @IsOptional()
  @IsBoolean({ message: MSG.boolean("dirección de la plataforma") })
  platformAddress?: boolean;

  // P2A — Spanish fiscal compliance.

  @ApiPropertyOptional({ example: "B12345678", description: "Spanish tax ID (NIF/CIF/NIE). Required when fiscalMode != 'none'." })
  @IsOptional()
  @IsString({ message: MSG.text("NIF") })
  taxId?: string;

  @ApiPropertyOptional({
    enum: NifType,
    example: "cif",
    description: "Classification of taxId. AEAT rejects mismatched values.",
  })
  @IsOptional()
  @IsEnum(NifType, { message: MSG.nifType })
  taxIdType?: NifType;

  @ApiPropertyOptional({
    example: "Glamour Studio S.L.",
    description: "Legal name of the issuing entity. May differ from `name`.",
  })
  @IsOptional()
  @IsString({ message: MSG.text("razón social") })
  legalName?: string;
}