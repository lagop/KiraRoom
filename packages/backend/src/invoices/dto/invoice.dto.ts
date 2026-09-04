import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  IsArray,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";

export class CreateInvoiceLineDto {
  @ApiProperty()
  @IsString()
  description!: string;

  @ApiProperty({ minimum: 0 })
  @IsNumber()
  @Min(0)
  quantity!: number;

  @ApiProperty({ description: "Unit price in cents" })
  @IsInt()
  @Min(0)
  unitPriceCents!: number;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  discountPct?: number;

  @ApiProperty({ description: "Tax rate percent (e.g. 21 for 21% IVA)" })
  @IsNumber()
  @Min(0)
  taxRate!: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  productId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  serviceId?: string;
}

export class CreateInvoiceDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  series?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  issueDate?: string;

  @ApiPropertyOptional({ enum: ["client", "tenant"] })
  @IsOptional()
  @IsEnum(["client", "tenant"])
  recipientType?: "client" | "tenant";

  @ApiPropertyOptional({ description: "Client.id when recipientType=client" })
  @IsOptional()
  @IsString()
  recipientId?: string;

  @ApiProperty()
  @IsString()
  recipientName!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  recipientTaxId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  recipientAddress?: Record<string, unknown>;

  @ApiProperty({ type: [CreateInvoiceLineDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreateInvoiceLineDto)
  lines!: CreateInvoiceLineDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

export class ListInvoicesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  series?: string;

  @ApiPropertyOptional({ enum: ["draft", "issued", "paid", "cancelled", "refunded"] })
  @IsOptional()
  @IsString()
  status?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  fromDate?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString()
  toDate?: string;

  @ApiPropertyOptional({ default: 50 })
  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number;
}

export class UpdateTenantFiscalSettingsDto {
  @ApiPropertyOptional({ enum: ["none", "verifactu", "ticketbai", "sii_only"] })
  @IsOptional()
  @IsEnum(["none", "verifactu", "ticketbai", "sii_only"])
  fiscalMode?: "none" | "verifactu" | "ticketbai" | "sii_only";

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  defaultSeries?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @Min(0)
  defaultTaxRate?: number;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  autoInvoiceAppointments?: boolean;

  @ApiPropertyOptional({ enum: ["bizkaia", "gipuzkoa", "alava"] })
  @IsOptional()
  @IsEnum(["bizkaia", "gipuzkoa", "alava"])
  diputacion?: "bizkaia" | "gipuzkoa" | "alava" | null;

  @ApiPropertyOptional({ description: "Emitter NIF/CIF/NIE — mirrored to Tenant.taxId" })
  @IsOptional()
  @IsString()
  tenantNif?: string;

  @ApiPropertyOptional({ enum: ["nif", "cif", "nie", "passport", "other"] })
  @IsOptional()
  @IsEnum(["nif", "cif", "nie", "passport", "other"])
  taxIdType?: "nif" | "cif" | "nie" | "passport" | "other";

  @ApiPropertyOptional({ description: "Legal name (razón social) for the emitter" })
  @IsOptional()
  @IsString()
  legalName?: string;
}

export class CancelInvoiceDto {
  @ApiProperty()
  @IsString()
  reason!: string;
}