import { z } from 'zod';

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

export type GrantAddOnDto = z.infer<typeof GrantAddOnSchema>;
