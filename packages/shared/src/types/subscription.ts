// Single source of truth for the SaaS plan catalog (rev 3).
//
// Backend imports these for the SaaS service plan prices and the
// schema enum. Frontend imports them to render plan badges, the
// pricing cards on the marketing landing, and the SaaS tenants
// page. Previously scattered across:
//   - packages/backend/src/saas/saas.constants.ts (PLAN_PRICES)
//   - packages/backend/src/saas/saas.service.ts (legacyMap inline)
//   - packages/backend/src/payments/services/subscriptions.service.ts
//     (REV3_PLANS, LEGACY_TO_REV3, PlanId type)
//   - packages/shared/src/utils/constants.ts (legacy SUBSCRIPTION_PLANS)
//   - packages/frontend/app/saas/tenants/page.tsx (color map)
//   - packages/frontend/app/saas/tenants/[id]/edit/page.tsx (option list)

/** Canonical plan identifiers (rev 3). Persisted to the DB. */
export const PLAN_IDS = ['esencial', 'pro', 'empresa'] as const;
export type PlanId = (typeof PLAN_IDS)[number];

/** Plan prices in EUR / month. Single source of truth. */
export const PLAN_PRICES: Readonly<Record<PlanId, number>> = {
  esencial: 29,
  pro: 59,
  empresa: 119,
};

/**
 * Map every legacy plan alias to its canonical rev 3 equivalent. Used
 * by the auth and SaaS tenant-creation paths to silently accept
 * existing tenants + Stripe webhooks that were created under the
 * pre-rev-3 plan names. New code should write canonical names only.
 */
export const LEGACY_PLAN_ALIASES: Readonly<Record<string, PlanId>> = {
  basic: 'esencial',
  professional: 'pro',
  advanced: 'empresa',
  enterprise: 'empresa',
};

/** Tailwind color tokens per plan, used by the SaaS tenants badge. */
export const PLAN_BADGE_CLASSES: Readonly<Record<PlanId, string>> = {
  esencial: 'bg-slate-100 text-slate-800',
  pro: 'bg-blue-100 text-blue-800',
  empresa: 'bg-purple-100 text-purple-800',
};

/** Spanish labels (rev 3). English is in the i18n message files. */
export const PLAN_LABELS_ES: Readonly<Record<PlanId, string>> = {
  esencial: 'Esencial',
  pro: 'Pro',
  empresa: 'Empresa',
};

/**
 * Normalize any user-supplied plan identifier (including legacy aliases)
 * to a canonical PlanId. Unknown / empty input defaults to "esencial".
 */
export function normalizePlan(input?: string | null): PlanId {
  if (!input) return 'esencial';
  const aliased = LEGACY_PLAN_ALIASES[input];
  if (aliased) return aliased;
  if ((PLAN_IDS as readonly string[]).includes(input)) {
    return input as PlanId;
  }
  return 'esencial';
}

/** True iff the plan is a known canonical PlanId. */
export function isPlanId(value: unknown): value is PlanId {
  return typeof value === 'string' && (PLAN_IDS as readonly string[]).includes(value);
}
