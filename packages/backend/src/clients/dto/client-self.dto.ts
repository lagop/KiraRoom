import { ApiPropertyOptional, ApiProperty } from "@nestjs/swagger";
import { IsEmail, IsIn, IsOptional, IsString, MaxLength, MinLength } from "class-validator";

/**
 * What a client may change about themselves from the salon site's account
 * area. Deliberately narrow: no status, tags, notes, tax id or anything else
 * the salon owns on the record.
 */
export class UpdateMyProfileDto {
  @ApiPropertyOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @IsOptional()
  firstName?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(100)
  @IsOptional()
  lastName?: string;

  @ApiPropertyOptional()
  @IsEmail()
  @IsOptional()
  email?: string;

  @ApiPropertyOptional()
  @IsString()
  @MaxLength(30)
  @IsOptional()
  phone?: string;

  @ApiPropertyOptional({ enum: ["es", "en"] })
  @IsIn(["es", "en"])
  @IsOptional()
  preferredLanguage?: string;
}

export class ChangeMyPasswordDto {
  @ApiProperty()
  @IsString()
  currentPassword: string;

  /** Same floor as registration and login. */
  @ApiProperty()
  @IsString()
  @MinLength(8)
  @MaxLength(128)
  newPassword: string;
}
