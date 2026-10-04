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
} from "class-validator";

export const EARN_MODES = ["per_euro", "per_visit"] as const;
export type EarnMode = (typeof EARN_MODES)[number];

export const REWARD_TYPES = ["discount", "free_service", "product", "voucher"] as const;

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
  discountAmount?: number;

  @IsOptional() @IsUUID()
  freeServiceId?: string;

  @IsOptional() @IsBoolean()
  isActive?: boolean;
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
