import {
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  NotEquals,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  IsDateString,
} from "class-validator";

export const EARN_MODES = ["per_euro", "per_visit"] as const;
export type EarnMode = (typeof EARN_MODES)[number];

export const REWARD_TYPES = ["discount", "free_service", "product", "voucher"] as const;

const BOTH = "Un descuento es un porcentaje o un importe fijo, no los dos.";
const NEITHER = "Indica el descuento: un porcentaje o un importe fijo mayor que 0.";

/**
 * A discount reward takes off exactly one thing: a percent or an amount,
 * above zero. Null when the values are fine (or the reward is no discount).
 */
export function discountValueProblem(
  type: string | undefined,
  percent?: number | null,
  amount?: number | null,
): string | null {
  if (type !== "discount") return null;
  const hasPercent = typeof percent === "number" && percent > 0;
  const hasAmount = typeof amount === "number" && amount > 0;
  if (hasPercent && hasAmount) return BOTH;
  if (!hasPercent && !hasAmount) return NEITHER;
  return null;
}

/**
 * The body's discount (discountValueProblem). With `{ partial: true }` (an
 * edit) only what the body itself says is checked, both above zero at
 * once; the service checks the reward as it will stand.
 */
@ValidatorConstraint({ name: "discountValue", async: false })
class DiscountValueConstraint implements ValidatorConstraintInterface {
  private problem(args: ValidationArguments): string | null {
    const o = args.object as { type?: string; discountPercent?: number | null; discountAmount?: number | null };
    const partial = (args.constraints?.[0] as { partial?: boolean } | undefined)?.partial;
    if (partial) return (o.discountPercent ?? 0) > 0 && (o.discountAmount ?? 0) > 0 ? BOTH : null;
    return discountValueProblem(o.type, o.discountPercent, o.discountAmount);
  }

  validate(_value: unknown, args: ValidationArguments): boolean {
    return this.problem(args) === null;
  }

  defaultMessage(args: ValidationArguments): string {
    return this.problem(args) ?? NEITHER;
  }
}

/** The salon's programme. One per salon (LoyaltyProgram.tenantId is unique). */
export class LoyaltyProgramSettingsDto {
  @IsOptional() @IsString() @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  @IsOptional() @IsIn(EARN_MODES as unknown as string[])
  earnMode?: EarnMode;

  @IsOptional() @IsInt() @Min(0) @Max(1000)
  pointsPerEuro?: number;

  @IsOptional() @IsInt() @Min(0) @Max(100000)
  pointsPerVisit?: number;

  @IsOptional() @IsInt() @Min(0) @Max(1000000)
  minPointsRedemption?: number;

  @IsOptional() @IsInt() @Min(0) @Max(1000000)
  welcomePoints?: number;

  @IsOptional() @IsBoolean()
  autoEnroll?: boolean;

  @IsOptional() @IsBoolean()
  allowSelfEnroll?: boolean;
}

export class LoyaltyRewardDto {
  @IsString() @MaxLength(120)
  name!: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  @IsIn(REWARD_TYPES as unknown as string[])
  @Validate(DiscountValueConstraint)
  type!: (typeof REWARD_TYPES)[number];

  @IsInt() @Min(1) @Max(1000000)
  pointsCost!: number;

  /** Percentage off the ticket (discount rewards). */
  @IsOptional() @IsInt() @Min(0) @Max(100)
  discountPercent?: number;

  /** Fixed amount off the ticket, in cents (discount rewards). */
  @IsOptional() @IsInt() @Min(0) @Max(10000000)
  discountAmount?: number;

  /** The service a free_service reward pays for. */
  @IsOptional() @IsUUID()
  freeServiceId?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  /** How many times it can be redeemed in all; empty: no limit. */
  @IsOptional() @IsInt() @Min(1) @Max(1000000)
  maxRedemptions?: number | null;

  /** The last moment it can be redeemed (ISO date-time); empty: it never expires. */
  @IsOptional() @IsDateString()
  expiresAt?: string | null;
}

export class UpdateLoyaltyRewardDto {
  @IsOptional() @IsString() @MaxLength(120)
  name?: string;

  @IsOptional() @IsString() @MaxLength(1000)
  description?: string;

  @IsOptional() @IsIn(REWARD_TYPES as unknown as string[])
  type?: (typeof REWARD_TYPES)[number];

  @IsOptional() @IsInt() @Min(1) @Max(1000000)
  pointsCost?: number;

  @IsOptional() @IsInt() @Min(0) @Max(100)
  discountPercent?: number;

  @IsOptional() @IsInt() @Min(0) @Max(10000000)
  @Validate(DiscountValueConstraint, [{ partial: true }])
  discountAmount?: number;

  @IsOptional() @IsUUID()
  freeServiceId?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;

  /** null: no limit. */
  @IsOptional() @IsInt() @Min(1) @Max(1000000)
  maxRedemptions?: number | null;

  /** null: it never expires. */
  @IsOptional() @IsDateString()
  expiresAt?: string | null;
}

export class LoyaltyTierDto {
  @IsString() @MaxLength(60)
  name!: string;

  @IsInt() @Min(0) @Max(100000000)
  minPoints!: number;

  /** 1.5 = 50 % more points per visit or euro. */
  @IsNumber() @Min(1) @Max(10)
  pointsMultiplier!: number;
}

export class EnrollMemberDto {
  @IsUUID()
  clientId!: string;
}

export class AdjustPointsDto {
  @IsInt() @NotEquals(0) @Min(-1000000) @Max(1000000)
  points!: number;

  @IsString() @MaxLength(300)
  reason!: string;
}
