import { Type } from "class-transformer";
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsString,
  IsUrl,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { EmptyStringToUndefined } from "../../common/dto/empty-to-undefined";

export const POS_PAYMENT_METHODS = ["card", "cash", "bank_transfer", "wallet", "gift_card"] as const;
export type PosPaymentMethod = (typeof POS_PAYMENT_METHODS)[number];

/** Cents: one million euros is no salon ticket. */
const MAX_CENTS = 100_000_000;
const MAX_EUROS = 1_000_000;

/**
 * One line of the cart: what is sold and how many. The price is NOT read
 * from here: the server prices each line from the service or product in
 * the database, and an appointment's line from what the appointment still
 * owes. The panel also sends `name` and `price` (cents); they are dropped.
 */
export class PosCartItemDto {
  @ValidateIf((o) => !o.productId)
  @IsUUID()
  serviceId?: string;

  @ValidateIf((o) => !o.serviceId)
  @IsUUID()
  productId?: string;

  /** The appointment this line charges; must be one of the ticket's appointmentIds. */
  @IsOptional()
  @IsUUID()
  appointmentId?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  quantity!: number;
}

export class PosTenderDto {
  @IsIn(POS_PAYMENT_METHODS as unknown as string[])
  method!: PosPaymentMethod;

  /** Cents. */
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(MAX_CENTS)
  amount!: number;
}

/** A walk-in client created (or found by phone) at the till. */
export class PosClientInfoDto {
  @IsString() @IsNotEmpty() @MaxLength(100)
  firstName!: string;

  @IsOptional() @IsString() @MaxLength(100)
  lastName?: string;

  @EmptyStringToUndefined() @IsOptional() @IsEmail() @MaxLength(254)
  email?: string;

  @EmptyStringToUndefined() @IsOptional() @IsString() @MaxLength(30)
  phone?: string;
}

/**
 * Body of `POST /pos/checkout`. It was an interface, so the pipe let
 * everything through, and each line's price came from the client: any
 * ticket could be rung up for any amount. The tenant and the actor come
 * from the JWT (the controller), never from here.
 */
export class CreatePosOrderDto {
  @IsOptional() @IsUUID()
  clientId?: string;

  @IsOptional() @ValidateNested() @Type(() => PosClientInfoDto)
  clientInfo?: PosClientInfoDto;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => PosCartItemDto)
  items!: PosCartItemDto[];

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10)
  @ValidateNested({ each: true }) @Type(() => PosTenderDto)
  payments!: PosTenderDto[];

  @IsOptional() @IsString() @MaxLength(5000)
  notes?: string;

  /** Appointments this ticket pays for (the till's "charge appointment" flow). */
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID("all", { each: true })
  appointmentIds?: string[];

  /** A loyalty reward the client spends points on: comes off the total. */
  @IsOptional() @IsUUID()
  loyaltyRewardId?: string;
}

/** Body of `POST /pos/quick-sale`: one service, priced from the database. */
export class PosQuickSaleDto {
  @IsUUID()
  serviceId!: string;

  @IsIn(["cash", "card"])
  paymentMethod!: "cash" | "card";

  @IsOptional() @IsUUID()
  clientId?: string;
}

/**
 * Body of `POST /pos/products`. Was `any`; the service already picked the
 * columns, but types and ranges were whatever came. Prices in euros, as
 * the products page sends them; Decimals may come back as strings.
 */
export class CreateProductDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  name!: string;

  @IsOptional() @IsString() @MaxLength(5000)
  description?: string | null;

  @EmptyStringToUndefined() @IsOptional() @IsString() @MaxLength(100)
  sku?: string | null;

  @EmptyStringToUndefined() @IsOptional() @IsString() @MaxLength(100)
  barcode?: string | null;

  @IsOptional() @IsString() @MaxLength(200)
  category?: string | null;

  @IsOptional() @IsString() @MaxLength(200)
  subcategory?: string | null;

  @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_EUROS)
  price!: number;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_EUROS)
  costPrice?: number | null;

  @IsOptional() @IsIn(["EUR"])
  currency?: string;

  @IsOptional() @IsBoolean()
  trackInventory?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1_000_000)
  quantity?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1_000_000)
  lowStockAlert?: number;

  @EmptyStringToUndefined() @IsOptional() @IsUrl() @MaxLength(2000)
  imageUrl?: string | null;

  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUrl({}, { each: true }) @MaxLength(2000, { each: true })
  images?: string[];

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  @IsOptional() @IsBoolean()
  isFeatured?: boolean;

  /** A fraction: 0.21 for 21 %. */
  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(1)
  taxRate?: number | null;

  @IsOptional() @IsBoolean()
  showOnline?: boolean;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_EUROS)
  onlinePrice?: number | null;

  @IsOptional() @IsBoolean()
  earnPoints?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1_000_000)
  pointsEarned?: number;
}

/** Body of `PATCH /pos/products/:id`: any subset of the product's fields. */
export class UpdateProductDto {
  @IsOptional() @IsString() @IsNotEmpty() @MaxLength(200)
  name?: string;

  @IsOptional() @IsString() @MaxLength(5000)
  description?: string | null;

  @EmptyStringToUndefined() @IsOptional() @IsString() @MaxLength(100)
  sku?: string | null;

  @EmptyStringToUndefined() @IsOptional() @IsString() @MaxLength(100)
  barcode?: string | null;

  @IsOptional() @IsString() @MaxLength(200)
  category?: string | null;

  @IsOptional() @IsString() @MaxLength(200)
  subcategory?: string | null;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_EUROS)
  price?: number;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_EUROS)
  costPrice?: number | null;

  @IsOptional() @IsIn(["EUR"])
  currency?: string;

  @IsOptional() @IsBoolean()
  trackInventory?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1_000_000)
  quantity?: number;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1_000_000)
  lowStockAlert?: number;

  @EmptyStringToUndefined() @IsOptional() @IsUrl() @MaxLength(2000)
  imageUrl?: string | null;

  @IsOptional() @IsArray() @ArrayMaxSize(20) @IsUrl({}, { each: true }) @MaxLength(2000, { each: true })
  images?: string[];

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  @IsOptional() @IsBoolean()
  isFeatured?: boolean;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 4 }) @Min(0) @Max(1)
  taxRate?: number | null;

  @IsOptional() @IsBoolean()
  showOnline?: boolean;

  @IsOptional() @Type(() => Number) @IsNumber({ maxDecimalPlaces: 2 }) @Min(0) @Max(MAX_EUROS)
  onlinePrice?: number | null;

  @IsOptional() @IsBoolean()
  earnPoints?: boolean;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(1_000_000)
  pointsEarned?: number;
}

/** Body of `POST /pos/products/categories`. */
export class CreateProductCategoryDto {
  @IsString() @IsNotEmpty() @MaxLength(200)
  name!: string;

  @IsOptional() @IsString() @MaxLength(2000)
  description?: string;

  @IsOptional() @IsUUID()
  parentId?: string;

  @EmptyStringToUndefined() @IsOptional() @IsUrl() @MaxLength(2000)
  imageUrl?: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(0) @Max(10_000)
  displayOrder?: number;
}

export const INVENTORY_ADJUSTMENT_TYPES = ["restock", "adjustment", "transfer", "damaged", "expired"] as const;

/** Body of `POST /pos/inventory/adjust`. */
export class InventoryAdjustmentBodyDto {
  @IsUUID()
  productId!: string;

  @IsIn(INVENTORY_ADJUSTMENT_TYPES as unknown as string[])
  type!: (typeof INVENTORY_ADJUSTMENT_TYPES)[number];

  /** Units moved; for "adjustment", the new stock. */
  @Type(() => Number) @IsInt() @Min(0) @Max(1_000_000)
  quantity!: number;

  @IsOptional() @IsString() @MaxLength(500)
  reason?: string;
}
