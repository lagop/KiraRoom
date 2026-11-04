// Plan prices come from @kira/shared. This file used to declare its own
// copy -- 29 / 59 / 119, an earlier pricing revision -- and "keeping this
// and the shared copy aligned" was left to a review that never caught it.
// Re-exported rather than deleted so existing imports keep working.
export { PLAN_PRICES } from "@kira/shared";

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
 * Canonical predicate for "a salon that counts" in platform figures,
 * alerts and anything else that should ignore our own salons: not
 * soft-deleted and not flagged internal (Tenant.isInternal: the Platform
 * tenant and our test salons, audit 8 D11). Spread it, or pass the extra
 * conditions:
 *
 *   prisma.tenant.count({ where: countableTenantWhere({ plan: "pro" }) })
 *   prisma.client.count({ where: { tenant: COUNTABLE_TENANT_WHERE } })
 */
export const COUNTABLE_TENANT_WHERE = { deletedAt: null, isInternal: false } as const;

export function countableTenantWhere<T extends object>(
  where?: T,
): T & typeof COUNTABLE_TENANT_WHERE {
  return { ...(where ?? ({} as T)), ...COUNTABLE_TENANT_WHERE };
}

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
