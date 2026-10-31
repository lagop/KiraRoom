import { ApiProperty, ApiPropertyOptional } from "@nestjs/swagger";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBase64,
  IsBoolean,
  IsDateString,
  IsEnum,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { Type } from "class-transformer";
import { TAX_REGIMES, type TaxRegime } from "@kira/shared";

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

  /**
   * `unitPriceCents` already includes the tax, and the line is split into
   * base + tax (InvoiceLineInput.taxIncluded). The manual invoice form sends
   * it on every line, true or false, from the salon's pricesIncludeTax
   * (Ajustes fiscales). Left out: the salon's pricesIncludeTax, decided on
   * the server (it used to be false, the tax on top, whatever the salon's
   * setting). Without this property the global ValidationPipe (whitelist)
   * dropped it silently and every line was taxed on top.
   */
  @ApiPropertyOptional({
    description:
      "The unit price already includes the tax (true) or the tax is added on top (false). Left out: the salon's pricesIncludeTax setting",
  })
  @IsOptional()
  @IsBoolean()
  taxIncluded?: boolean;
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

  /**
   * Indirect tax regime of the tenant's territory: "iva" in the peninsula and
   * the Balearics, "igic" in the Canary Islands, "ipsi" in Ceuta and Melilla.
   * It decides what the tax is called and which quarterly return applies.
   */
  @ApiPropertyOptional({ enum: TAX_REGIMES })
  @IsOptional()
  @IsIn(TAX_REGIMES as unknown as string[])
  taxRegime?: TaxRegime;

  /**
   * Whether the prices the salon sets on its services and products already
   * include the tax (IVA / IGIC / IPSI). True: an invoice splits the price
   * into base + tax. False: the tax is added on top. See salon-tax-settings.ts.
   */
  @ApiPropertyOptional({ description: "Salon prices already include the tax (true) or have it added on top (false)" })
  @IsOptional()
  @IsBoolean()
  pricesIncludeTax?: boolean;

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
/**
 * A line of a rectifying invoice. The quantity may be negative: a
 * rectification "por diferencias" credits part of the original.
 *
 * With `originalLineId` the line credits that line of the original: its
 * description, price, discount and rate are taken from it (any sent are
 * ignored) and `quantity` says how much of it, negative (minus the whole
 * quantity: its exact amounts, negated). See rectification-lines.ts.
 */
export class RectificationLineDto {
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  originalLineId?: string;

  @ValidateIf((o: RectificationLineDto) => o.originalLineId === undefined || o.originalLineId === null)
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  description?: string;

  @IsNumber({ maxDecimalPlaces: 3 })
  @Min(-10_000)
  @Max(10_000)
  quantity!: number;

  @ValidateIf((o: RectificationLineDto) => o.originalLineId === undefined || o.originalLineId === null)
  @IsInt()
  @Min(0)
  @Max(100_000_000)
  unitPriceCents?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(100)
  discountPct?: number;

  @ValidateIf((o: RectificationLineDto) => o.originalLineId === undefined || o.originalLineId === null)
  @IsNumber()
  @Min(0)
  @Max(100)
  taxRate?: number;
}

/**
 * Body of `POST /invoices/:id/rectify`. Was an inline type. Without
 * `lines`, the whole original is rectified: every line, its exact amounts
 * negated, so the two invoices net to zero.
 */
export class RectifyInvoiceDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;

  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => RectificationLineDto)
  lines?: RectificationLineDto[];
}

/**
 * Body of `POST /invoices/certificates`. Was an inline type: any provider
 * string and any size reached the encrypted store.
 */
export class UploadCertificateDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  alias!: string;

  @IsIn(["p12", "cloud_dnie"])
  provider!: "p12" | "cloud_dnie";

  /** A .p12 is a few KB; 200 000 base64 characters is about 150 KB. */
  @IsBase64()
  @MaxLength(200_000)
  pkcs12Base64!: string;

  @IsString()
  @MaxLength(500)
  passphrase!: string;
}
