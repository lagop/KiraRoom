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

/**
 * Plan prices in EUR / month. Single source of truth.
 *
 * These were 29 / 59 / 119 -- an earlier pricing revision -- while the
 * catalogue the customer actually pays from (`SubscriptionsService.plans`)
 * and the marketing site both said 49 / 79 / 149. That was not only a
 * display bug: `SaaSService.getOverview()` computes MRR from this map, so
 * the platform's own revenue figure under-reported by about 40%.
 *
 * `empresa` is per location; a tenant's bill is this times its location
 * count.
 */
export const PLAN_PRICES: Readonly<Record<PlanId, number>> = {
  esencial: 49,
  pro: 79,
  empresa: 149,
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

/**
 * Tailwind color tokens per plan, used by the SaaS tenants badge.
 *
 * Covers both canonical rev-3 plan ids (esencial / pro / empresa) and
 * legacy aliases (basic / professional / advanced / enterprise) so
 * the SaaS admin badge stays consistent across the rev-3 migration.
 * `frontend/app/saas/tenants/page.tsx` getPlanBadge() looks up by the
 * raw `tenant.plan` string without normalization, so the lookup map
 * needs both naming schemes. A plain Record<string, string> would
 * lose the canonical PlanId type at the call site.
 */
export const PLAN_BADGE_CLASSES: Readonly<Record<string, string>> = {
  // Canonical rev-3 plan ids.
  esencial: 'bg-slate-100 text-slate-800',
  pro: 'bg-blue-100 text-blue-800',
  empresa: 'bg-purple-100 text-purple-800',
  // Legacy aliases (pre-rev-3). Colors mirror the canonical mapping.
  basic: 'bg-slate-100 text-slate-800',
  professional: 'bg-blue-100 text-blue-800',
  advanced: 'bg-purple-100 text-purple-800',
  enterprise: 'bg-purple-100 text-purple-800',
  // Operational states shown by the SaaS admin UI.
  trial: 'bg-emerald-100 text-emerald-800',
  cancelled: 'bg-red-100 text-red-800',
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

// ---------------------------------------------------------------------------
//  Plan ↔ feature matrix
// ---------------------------------------------------------------------------
//
// This lived in four places that disagreed with each other: the backend
// (`SubscriptionsService.PLAN_MATRIX`), the frontend (`src/lib/plans.ts`),
// `docs/billing-plans-rev3.md` and `marketing/src/data/planMatrix.json` --
// each file declaring itself the single source of truth. The frontend copy
// still had `virtual_receptionist` as Pro-only after it moved to Esencial,
// and knew nothing about `multichannel` or the Copilot keys, so it showed
// "upgrade to Pro" for features the tenant already had.
//
// Both sides now import from here. The marketing JSON cannot import
// TypeScript, so a drift test asserts it matches instead.

/** Every gated capability in the product. */
export const FEATURE_KEYS = [
  'whatsapp_notifications',
  'sms_notifications',
  'email_marketing',
  'virtual_receptionist',
  'virtual_receptionist_advanced',
  'multichannel',
  'google_reviews_auto',
  'loyalty',
  'promotions',
  'gift_cards',
  'wallet',
  'commissions',
  'multi_location',
  'agenda_shifts',
  'consolidated_reports',
  'advanced_analytics',
  'copilot_read',
  'copilot_write',
  // Built but not sold. Filtered out of every public catalogue and UI.
  'api_access',
  'white_label',
  'custom_branding',
  // Add-on, not a plan feature: read from Tenant.addons.
  'web_domain',
] as const;

export type FeatureKey = (typeof FEATURE_KEYS)[number];

/** Keys that exist in the matrix but are never offered commercially. */
export const PARKED_FEATURE_KEYS: ReadonlySet<FeatureKey> = new Set<FeatureKey>([
  'api_access',
  'white_label',
  'custom_branding',
]);

const ESENCIAL_FEATURES: ReadonlyArray<FeatureKey> = [
  'whatsapp_notifications',
  // Fiscal Spain (Verifactu / TicketBAI) is intentionally ungated: it is
  // the entry hook, not an upgrade driver. See billing-plans-rev3 §13.
  'virtual_receptionist',
];

const PRO_FEATURES: ReadonlyArray<FeatureKey> = [
  ...ESENCIAL_FEATURES,
  'sms_notifications',
  'email_marketing',
  'virtual_receptionist_advanced',
  'multichannel',
  'loyalty',
  'promotions',
  'gift_cards',
  'wallet',
  'commissions',
  'advanced_analytics',
  'agenda_shifts',
  'copilot_read',
];

const EMPRESA_FEATURES: ReadonlyArray<FeatureKey> = [
  ...PRO_FEATURES,
  'multi_location',
  'consolidated_reports',
  'copilot_write',
  'api_access',
  'white_label',
  'custom_branding',
];

/** What each plan includes. Add-ons unlock extra keys on top of this. */
export const PLAN_FEATURES: Readonly<Record<PlanId, ReadonlyArray<FeatureKey>>> = {
  esencial: ESENCIAL_FEATURES,
  pro: PRO_FEATURES,
  empresa: EMPRESA_FEATURES,
};

/** Cheapest plan that includes a feature, for upgrade prompts. */
export function minPlanFor(key: FeatureKey): PlanId | null {
  for (const plan of PLAN_IDS) {
    if (PLAN_FEATURES[plan].includes(key)) return plan;
  }
  return null;
}

export function planIncludes(plan: PlanId, key: FeatureKey): boolean {
  return PLAN_FEATURES[plan].includes(key);
}

/** Professionals allowed per plan. null = unlimited. */
export const PLAN_MAX_PROFESSIONALS: Readonly<Record<PlanId, number | null>> = {
  esencial: 4,
  pro: 10,
  empresa: null,
};

/** AI receptionist conversations per month. null = unlimited. */
export const PLAN_AI_CONVERSATIONS: Readonly<Record<PlanId, number | null>> = {
  esencial: 500,
  pro: null,
  empresa: null,
};

/** Minimum billable locations. Empresa bills per location from 1 upwards. */
export const PLAN_MIN_LOCATIONS: Readonly<Record<PlanId, number>> = {
  esencial: 1,
  pro: 1,
  empresa: 1,
};
