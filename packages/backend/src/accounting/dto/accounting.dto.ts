import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Min,
} from "class-validator";

export class UpdateAccountingSettingsDto {
  @ApiPropertyOptional({ enum: ["holded", "sage"] })
  @IsOptional()
  @IsEnum(["holded", "sage"])
  provider?: "holded" | "sage" | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  syncOnIssue?: boolean;
}

export class SyncInvoiceDto {
  @ApiProperty()
  @IsString()
  invoiceId!: string;
}

export class RetryQueueDto {
  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}