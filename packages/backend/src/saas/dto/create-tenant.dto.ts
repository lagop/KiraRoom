import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsString,
  IsOptional,
  IsEmail,
  IsEnum,
  IsBoolean,
  IsUrl,
  IsArray,
  MaxLength,
  MinLength,
} from "class-validator";
import { EmptyStringToUndefined } from "../../common/dto/empty-to-undefined";
import { SubscriptionPlan, SubscriptionStatus } from "@prisma/client";

export class CreateTenantDto {
  @ApiProperty({ example: "Glamour Studio" })
  @IsString()
  name: string;

  @ApiPropertyOptional({ example: "glamour-studio" })
  @IsOptional()
  @IsString()
  slug?: string;

  @ApiPropertyOptional({ example: "Best salon in town" })
  @IsOptional()
  @IsString()
  description?: string;

  @ApiPropertyOptional()
  @EmptyStringToUndefined()
  @IsOptional()
  @IsUrl()
  logo?: string;

  @ApiPropertyOptional()
  @EmptyStringToUndefined()
  @IsOptional()
  @IsUrl()
  coverImage?: string;

  @ApiPropertyOptional({ example: "https://glamourstudio.com" })
  @EmptyStringToUndefined()
  @IsOptional()
  @IsUrl()
  website?: string;

  @ApiPropertyOptional({ example: "contact@glamourstudio.com" })
  @IsOptional()
  @IsEmail()
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

  @ApiProperty({ enum: SubscriptionPlan, example: "basic" })
  @IsEnum(SubscriptionPlan)
  plan: SubscriptionPlan;

  @ApiPropertyOptional({ enum: SubscriptionStatus, example: "active" })
  @IsOptional()
  @IsEnum(SubscriptionStatus)
  subscriptionStatus?: SubscriptionStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  ownerEmail?: string;

  /**
   * Left empty, the owner gets no usable password and an email with a link to
   * choose one. When given, the same length rule as signup.
   */
  @ApiPropertyOptional({ description: "8 to 128 characters; empty sends the owner a link to choose one" })
  @EmptyStringToUndefined()
  @IsOptional()
  @IsString()
  @MinLength(8, { message: "La contraseña debe tener al menos 8 caracteres." })
  @MaxLength(128, { message: "La contraseña es demasiado larga (máximo 128 caracteres)." })
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