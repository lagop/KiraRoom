// Single source of truth for plan / feature gating in the frontend.
// Mirrors `packages/backend/src/payments/services/subscriptions.service.ts`.

export type PlanId = "esencial" | "pro" | "empresa";

export type FeatureKey =
  | "whatsapp_notifications"
  | "sms_notifications"
  | "email_marketing"
  | "virtual_receptionist"
  | "loyalty"
  | "promotions"
  | "gift_cards"
  | "wallet"
  | "commissions"
  | "multi_location"
  | "agenda_shifts"
  | "consolidated_reports"
  | "advanced_analytics"
  | "api_access"
  | "white_label"
  | "custom_branding"
  | "web_domain"; // add-on

// Feature matrix (kept in sync with backend SubscriptionsService.PLAN_MATRIX).
export const PLAN_MATRIX: Record<PlanId, ReadonlyArray<FeatureKey>> = {
  esencial: ["whatsapp_notifications"],
  pro: [
    "whatsapp_notifications",
    "sms_notifications",
    "email_marketing",
    "virtual_receptionist",
    "loyalty",
    "promotions",
    "gift_cards",
    "wallet",
    "commissions",
    "advanced_analytics",
    "agenda_shifts",
  ],
  empresa: [
    "whatsapp_notifications",
    "sms_notifications",
    "email_marketing",
    "virtual_receptionist",
    "loyalty",
    "promotions",
    "gift_cards",
    "wallet",
    "commissions",
    "advanced_analytics",
    "agenda_shifts",
    "multi_location",
    "consolidated_reports",
    "api_access",
    "white_label",
    "custom_branding",
  ],
};

// Plan required to unlock a given feature (for upgrade CTAs).
export const FEATURE_MIN_PLAN: Record<FeatureKey, PlanId> = {
  whatsapp_notifications: "esencial",
  sms_notifications: "pro",
  email_marketing: "pro",
  virtual_receptionist: "pro",
  loyalty: "pro",
  promotions: "pro",
  gift_cards: "pro",
  wallet: "pro",
  commissions: "pro",
  advanced_analytics: "pro",
  agenda_shifts: "pro",
  multi_location: "empresa",
  consolidated_reports: "empresa",
  api_access: "empresa",
  white_label: "empresa",
  custom_branding: "empresa",
  // add-on: not gated by plan
  web_domain: "esencial",
};

const LEGACY_TO_REV3: Record<string, PlanId> = {
  basic: "esencial",
  professional: "pro",
  advanced: "empresa",
  enterprise: "empresa",
};

// Feature keys kept for backwards compatibility but NOT exposed in the
// public catalog / upgrade UI (plan section 4.9 "Aparcados").
// The backend (SubscriptionsService.getPublicPlans) already filters these
// out, but we keep the set on the frontend so any code that iterates
// PLAN_MATRIX locally can apply the same filter.
export const PARKED_FEATURE_KEYS: ReadonlySet<FeatureKey> = new Set([
  "api_access",
  "white_label",
  "custom_branding",
]);
export const normalizePlan = (plan: string | null | undefined): PlanId => {
  if (!plan) return "esencial";
  if (plan in LEGACY_TO_REV3) return LEGACY_TO_REV3[plan];
  if (plan === "esencial" || plan === "pro" || plan === "empresa") {
    return plan;
  }
  return "esencial";
};

export const isFeatureEnabledForPlan = (
  plan: PlanId,
  key: FeatureKey,
): boolean => {
  return PLAN_MATRIX[plan]?.includes(key) ?? false;
};

export const PLAN_LABELS: Record<PlanId, string> = {
  esencial: "Esencial",
  pro: "Pro",
  empresa: "Empresa",
};

export const PLAN_PRICE_EUR: Record<PlanId, number> = {
  esencial: 49,
  pro: 79,
  empresa: 149,
};
