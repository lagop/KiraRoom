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
  IsPositive,
  Matches,
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

  @ApiProperty({ minimum: 0, exclusiveMinimum: true })
  @IsNumber({ maxDecimalPlaces: 3 }, { message: "La cantidad tiene que ser un número." })
  @IsPositive({ message: "La cantidad tiene que ser mayor que cero." })
  @Max(100_000)
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

  /** One of the salon's regime (TAX_REGIME_RATES), checked by InvoiceService.createManual. */
  @ApiProperty({ description: "Tax rate percent (e.g. 21 for 21% IVA, 9.5 for IGIC)" })
  @IsNumber({ maxDecimalPlaces: 2 }, { message: "El tipo de impuesto tiene que ser un número." })
  @Min(0)
  @Max(100)
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
  /** Not R (rectificativas) nor T (tickets): refused by InvoiceService.createManual. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10, { message: "La serie no puede tener más de 10 caracteres." })
  @Matches(/^[A-Za-z0-9]*$/, { message: "La serie solo puede tener letras y números." })
  series?: string;

  /** Today (the salon's) or left out: an invoice is dated the day it is issued. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString({}, { message: "La fecha de expedición no es válida." })
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
  @ArrayMinSize(1, { message: "La factura necesita al menos una línea." })
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => CreateInvoiceLineDto)
  lines!: CreateInvoiceLineDto[];

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  notes?: string;
}

/** Statuses an invoice really has: issued, or cancelled (anulada). */
export const LISTED_INVOICE_STATUSES = ["issued", "cancelled"] as const;

/**
 * Query of `GET /invoices`. Query strings are strings: numbers are
 * converted (@Type) before they are checked. Newest first, a page at a time.
 */
export class ListInvoicesQueryDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(10)
  series?: string;

  @ApiPropertyOptional({ enum: LISTED_INVOICE_STATUSES })
  @IsOptional()
  @IsIn(LISTED_INVOICE_STATUSES as unknown as string[], {
    message: 'El estado tiene que ser "issued" (emitida) o "cancelled" (anulada).',
  })
  status?: (typeof LISTED_INVOICE_STATUSES)[number];

  /** A number ("A2027-000012", "12"), a client's name or a NIF. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(100, { message: "La búsqueda no puede tener más de 100 caracteres." })
  q?: string;

  /** First day (YYYY-MM-DD), included. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString({}, { message: "La fecha inicial no es válida." })
  dateFrom?: string;

  /** Last day (YYYY-MM-DD), included. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString({}, { message: "La fecha final no es válida." })
  dateTo?: string;

  /** Older name of dateFrom. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString({}, { message: "La fecha inicial no es válida." })
  fromDate?: string;

  /** Older name of dateTo. */
  @ApiPropertyOptional()
  @IsOptional()
  @IsDateString({}, { message: "La fecha final no es válida." })
  toDate?: string;

  @ApiPropertyOptional({ default: 50, maximum: 100 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "El límite tiene que ser un número entero." })
  @Min(1, { message: "El límite tiene que ser al menos 1." })
  @Max(100, { message: "El límite no puede pasar de 100." })
  limit?: number;

  /** Invoices to skip; takes precedence over page. */
  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "El desplazamiento tiene que ser un número entero." })
  @Min(0)
  @Max(1_000_000)
  offset?: number;

  /** 1-based page of `limit` invoices. */
  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt({ message: "La página tiene que ser un número entero." })
  @Min(1, { message: "La página empieza en 1." })
  @Max(100_000)
  page?: number;
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
  @IsString({ message: "Indica el motivo de la anulación." })
  @IsNotEmpty({ message: "Indica el motivo de la anulación." })
  @MaxLength(500, { message: "El motivo no puede tener más de 500 caracteres." })
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

  /**
   * A free line: `unitPriceCents` already includes the tax, and the line is
   * split into base + tax. Left out: the salon's pricesIncludeTax, as for a
   * manual invoice line (CreateInvoiceLineDto.taxIncluded). Ignored with
   * originalLineId: a credited line is split the way the original was.
   */
  @IsOptional()
  @IsBoolean()
  taxIncluded?: boolean;
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
