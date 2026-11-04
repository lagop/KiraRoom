import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  IsEmail,
  IsEnum,
  IsBoolean,
  IsUrl,
  IsArray,
  IsNotEmpty,
} from "class-validator";
import { EmptyStringToUndefined } from "../../common/dto/empty-to-undefined";
import { CONSOLE_DTO_MESSAGES as MSG } from "./console-dto-messages";
import { SubscriptionPlan, SubscriptionStatus } from "@prisma/client";

export class CreateTenantDto {
  @ApiProperty({ example: "Glamour Studio" })
  @IsString({ message: MSG.text("nombre del salón") })
  @IsNotEmpty({ message: "Escribe el nombre del salón." })
  name: string;

  @ApiPropertyOptional({ example: "glamour-studio" })
  @EmptyStringToUndefined()
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

  // Optional: the form sends "" when it is left empty (audit 8 T6).
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

  @ApiProperty({ enum: SubscriptionPlan, example: "basic" })
  @IsEnum(SubscriptionPlan, { message: MSG.plan })
  plan: SubscriptionPlan;

  @ApiPropertyOptional({ enum: SubscriptionStatus, example: "active" })
  @IsOptional()
  @IsEnum(SubscriptionStatus, { message: MSG.status })
  subscriptionStatus?: SubscriptionStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ownerEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ownerPassword?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ownerFirstName?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ownerLastName?: string;
}