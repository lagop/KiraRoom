// Single source of truth for plan prices, in EUR. Mirrored in
// packages/shared/src/types/subscription.ts so the frontend can render
// the same numbers without a round trip. Keeping this and the shared
// copy aligned is the responsibility of `rev 3: plan catalog` review.
export const PLAN_PRICES: Record<string, number> = {
  esencial: 29,
  pro: 59,
  empresa: 119,
};

export const IMPERSONATION_TTL_SECONDS = 60;
export const IMPERSONATION_AUDIENCE = "impersonation";
export const IMPERSONATION_DEFAULT_REASON = "support";

/**
 * Canonical predicate for "an active (non-soft-deleted) tenant". Spread
 * this into any Prisma where clause that needs to honor soft-delete so
 * we never introduce a 9th copy of `deletedAt: null`. Updated in lockstep
 * across the codebase if the soft-delete semantics ever expand.
 */
export const TENANT_ACTIVE_WHERE = { deletedAt: null } as const;

/**
 * Trial window (rev 3). Every new tenant gets this many days of Pro
 * access regardless of the plan they selected; pricing starts after
 * `trialEnd`. Single source of truth — both `saas.service.createTenant`
 * and `auth.service.register` import `computeTrialEnd()` from helpers.
 */
export const TRIAL_DAYS = 14;
export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Default bcrypt cost when `BCRYPT_ROUNDS` env is unset or invalid. */
export const BCRYPT_ROUNDS_DEFAULT = 12;
