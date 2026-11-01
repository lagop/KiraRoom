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
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateIf,
  ValidateNested,
  ValidationArguments,
  registerDecorator,
} from "class-validator";
import { EmptyStringToUndefined } from "../../common/dto/empty-to-undefined";
import { POS_DISCOUNT_TYPES, PosDiscountType } from "../pos-discounts";

export const POS_PAYMENT_METHODS = ["card", "cash", "bank_transfer", "bizum", "wallet", "gift_card"] as const;
export type PosPaymentMethod = (typeof POS_PAYMENT_METHODS)[number];

/** Cents: one million euros is no salon ticket. */
const MAX_CENTS = 100_000_000;
const MAX_EUROS = 1_000_000;

/**
 * A percentage discount is 0-100 with up to 2 decimals; a fixed one is
 * whole cents (up to MAX_CENTS). Whether a fixed amount fits the line or
 * the ticket is the server's check (pos-discounts.ts), on its own prices.
 */
function IsDiscountValue(): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    registerDecorator({
      name: "isDiscountValue",
      target: target.constructor,
      propertyName: propertyKey as string,
      validator: {
        validate: (value: unknown, args?: ValidationArguments) => {
          if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return false;
          const type = (args?.object as { type?: string })?.type;
          if (type === "percentage") return value <= 100 && Number.isInteger(Math.round(value * 1e6) / 1e4);
          if (type === "fixed") return Number.isInteger(value) && value <= MAX_CENTS;
          return false;
        },
        defaultMessage: (args?: ValidationArguments) =>
          (args?.object as { type?: string })?.type === "fixed"
            ? "Un descuento fijo va en céntimos: un número entero, 0 o más."
            : "Un descuento en porcentaje va de 0 a 100 (hasta 2 decimales).",
      },
    });
  };
}

/**
 * A discount asked for at the till, on a line or on the whole ticket:
 * what kind, how much and why. Never an amount to charge: the server works
 * the cents out from its own prices and checks who may give it.
 */
export class PosDiscountDto {
  @IsIn(POS_DISCOUNT_TYPES as unknown as string[], { message: "El descuento es en porcentaje o un importe fijo." })
  type!: PosDiscountType;

  /** percentage: percent (12.5 for 12,5 %). fixed: cents (500 for 5 €). */
  @Type(() => Number)
  @IsDiscountValue()
  value!: number;

  @EmptyStringToUndefined() @IsOptional() @IsString()
  @MaxLength(120, { message: "El motivo del descuento admite 120 caracteres como mucho." })
  reason?: string;
}

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

  /**
   * Who did a service sold without an appointment (its commission). Left
   * out: the professional of the team member at the till, if they have one.
   */
  @IsOptional()
  @IsUUID()
  professionalId?: string;

  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(99)
  quantity!: number;

  /** A discount on this line (see PosDiscountDto). */
  @IsOptional() @ValidateNested() @Type(() => PosDiscountDto)
  discount?: PosDiscountDto;
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

  /** For method gift_card: the card's code. */
  @EmptyStringToUndefined() @IsOptional() @IsString() @MaxLength(40)
  giftCardCode?: string;
}

/**
 * A gift card sold at the till: what it is worth and who it is for. A
 * multi-purpose voucher is not taxed when sold (only what it pays for,
 * later), so it is its own line, off the simplified invoice.
 */
export class PosGiftCardSaleDto {
  /** Cents: 1 € to 10.000 €. */
  @Type(() => Number)
  @IsInt({ message: "El importe de la tarjeta regalo va en céntimos." })
  @Min(100, { message: "Una tarjeta regalo es de 1 € como mínimo." })
  @Max(1_000_000, { message: "Una tarjeta regalo es de 10.000 € como mucho." })
  amountCents!: number;

  @EmptyStringToUndefined() @IsOptional() @IsString() @MaxLength(120)
  recipientName?: string;

  @EmptyStringToUndefined() @IsOptional() @IsEmail({}, { message: "El email de quien recibe la tarjeta no es válido." }) @MaxLength(254)
  recipientEmail?: string;

  @EmptyStringToUndefined() @IsOptional() @IsString() @MaxLength(500)
  message?: string;
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
 * Body of `POST /pos/quote`: the ticket as the till would charge it, priced
 * by the server, nothing written. The checkout's body without the payments.
 */
export class PosQuoteDto {
  @IsOptional() @IsUUID()
  clientId?: string;

  @IsOptional() @ValidateNested() @Type(() => PosClientInfoDto)
  clientInfo?: PosClientInfoDto;

  /** Services, products and appointments. May be empty when the ticket only sells gift cards. */
  @IsOptional() @IsArray() @ArrayMaxSize(100)
  @ValidateNested({ each: true }) @Type(() => PosCartItemDto)
  items?: PosCartItemDto[];

  /** Gift cards sold on this ticket. */
  @IsOptional() @IsArray() @ArrayMaxSize(10)
  @ValidateNested({ each: true }) @Type(() => PosGiftCardSaleDto)
  giftCards?: PosGiftCardSaleDto[];

  @IsOptional() @IsString() @MaxLength(5000)
  notes?: string;

  /** Appointments this ticket pays for (the till's "charge appointment" flow). */
  @IsOptional() @IsArray() @ArrayMaxSize(50) @IsUUID("all", { each: true })
  appointmentIds?: string[];

  /** A loyalty reward the client spends points on: comes off the total. */
  @IsOptional() @IsUUID()
  loyaltyRewardId?: string;

  /** A discount on the whole ticket, taken after the lines' own discounts. */
  @IsOptional() @ValidateNested() @Type(() => PosDiscountDto)
  discount?: PosDiscountDto;

  /**
   * A promotion code (Promociones) the client brings: checked and priced by
   * the server, taken after the manual discounts and before the loyalty
   * reward (promotions/promotion-at-till.ts). Outside the staff's limit.
   */
  @EmptyStringToUndefined() @IsOptional() @IsString()
  @MaxLength(50, { message: "El código promocional admite 50 caracteres como mucho." })
  @Matches(/^\s*\S+\s*$/, { message: "El código promocional no puede tener espacios." })
  promotionCode?: string;
}

/**
 * Body of `POST /pos/checkout`. It was an interface, so the pipe let
 * everything through, and each line's price came from the client: any
 * ticket could be rung up for any amount. The tenant and the actor come
 * from the JWT (the controller), never from here.
 */
export class CreatePosOrderDto extends PosQuoteDto {
  /**
   * The panel's id for this sale (a UUID it generates once per ticket): a
   * retried request with the same id returns the first sale's answer
   * instead of charging twice.
   */
  @IsOptional() @IsUUID("all", { message: "El identificador de la venta no es válido." })
  saleId?: string;

  @IsArray() @ArrayMinSize(1) @ArrayMaxSize(10)
  @ValidateNested({ each: true }) @Type(() => PosTenderDto)
  payments!: PosTenderDto[];
}

/** Body of `PUT /pos/settings` (owner and managers). */
export class PosSettingsDto {
  /** The most a staff member may take off a line, in percent. 0: staff cannot discount. */
  @Type(() => Number)
  @IsInt({ message: "El límite de descuento del personal es un porcentaje entero." })
  @Min(0, { message: "El límite de descuento del personal va de 0 a 100." })
  @Max(100, { message: "El límite de descuento del personal va de 0 a 100." })
  maxStaffDiscountPercent!: number;
}

export const QUICK_SALE_METHODS = ["cash", "card", "bank_transfer", "bizum"] as const;

/** Body of `POST /pos/quick-sale`: one service, priced from the database, paid exactly. */
export class PosQuickSaleDto {
  @IsUUID()
  serviceId!: string;

  @IsIn(QUICK_SALE_METHODS as unknown as string[], { message: "Forma de pago no válida." })
  paymentMethod!: (typeof QUICK_SALE_METHODS)[number];

  @IsOptional() @IsUUID()
  clientId?: string;

  /** As CreatePosOrderDto.saleId: a retry returns the first sale. */
  @IsOptional() @IsUUID("all", { message: "El identificador de la venta no es válido." })
  saleId?: string;
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
