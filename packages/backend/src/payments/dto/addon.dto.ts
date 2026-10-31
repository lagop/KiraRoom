import { z } from 'zod';
import { Type } from 'class-transformer';
import { IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * Public-facing shape of an add-on in catalog responses. Mirrors the
 * `addons` table but keeps the JSON `unlocks` typed as a typed array
 * of `FeatureKey` strings for downstream consumers.
 */
export const AddOnResponseSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  monthlyPriceCents: z.number().int().nullable(),
  currency: z.string(),
  unlocks: z.array(z.string()),
  metered: z.boolean(),
  stripePriceId: z.string().nullable(),
  isActive: z.boolean(),
  purchasable: z.boolean(),
  sortOrder: z.number().int(),
});

export type AddOnResponseDto = z.infer<typeof AddOnResponseSchema>;

/**
 * Tenant-side grant. Mirror of `tenant_add_ons` joined with `add_ons`.
 */
export const TenantAddOnResponseSchema = z.object({
  id: z.string(),
  tenantId: z.string(),
  addOn: AddOnResponseSchema,
  status: z.enum(['active', 'past_due', 'cancelled', 'expired']),
  isManualGrant: z.boolean(),
  startedAt: z.string().datetime(),
  currentPeriodEnd: z.string().datetime().nullable(),
  cancelledAt: z.string().datetime().nullable(),
});

export type TenantAddOnResponseDto = z.infer<typeof TenantAddOnResponseSchema>;

/**
 * Manual grant (operator path). For the Stripe path the webhook
 * handler fills these fields directly.
 */
export const GrantAddOnSchema = z.object({
  addOnKey: z.string(),
  durationDays: z.number().int().positive().max(365).optional(),
});

/**
 * The same rules as a class, for the ValidationPipe: the zod-inferred type
 * reached it as `Object`, and the handler's `GrantAddOnSchema.parse`
 * answered a bad body with a 500 (an uncaught ZodError) instead of a 400.
 */
export class GrantAddOnDto {
  @IsString() @IsNotEmpty() @MaxLength(100)
  addOnKey!: string;

  @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(365)
  durationDays?: number;
}
