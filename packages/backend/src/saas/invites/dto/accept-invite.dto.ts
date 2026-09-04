import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsEmail,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from "class-validator";

/**
 * Body for `POST /invites/:token/accept`.
 *
 * Atomic payload of the 3-step invite wizard:
 *   Step 1 — password
 *   Step 2 — salon address (street, city, postalCode, country)
 *   Step 3 — timezone (IANA, e.g. "Europe/Madrid")
 *
 * `firstName` / `lastName` are optional and override whatever the SaaS
 * admin pre-filled on the invite. Password is required because the
 * invite acceptance is what creates the owner User row.
 */
export class AcceptInviteDto {
  @ApiProperty({ example: "••••••••" })
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  password: string;

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

  @ApiProperty({ example: "Calle Gran Vía 28" })
  @IsString()
  @MaxLength(200)
  street: string;

  @ApiProperty({ example: "Madrid" })
  @IsString()
  @MaxLength(80)
  city: string;

  @ApiPropertyOptional({ example: "Madrid" })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  state?: string;

  @ApiProperty({ example: "28013" })
  @IsString()
  @MaxLength(20)
  postalCode: string;

  @ApiProperty({ example: "ES" })
  @IsString()
  @Matches(/^[A-Z]{2}$/, { message: "country must be a 2-letter ISO code" })
  country: string;

  @ApiProperty({ example: "Europe/Madrid" })
  @IsString()
  @MaxLength(64)
  timezone: string;

  @ApiPropertyOptional({ example: "EUR" })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currency?: string;

  @ApiPropertyOptional({ example: "es" })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  language?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  contactEmail?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(40)
  phone?: string;
}