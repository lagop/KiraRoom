"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Lock, Sparkles } from "lucide-react";
import { upgradeHeadline } from "../../../lib/plan-context";
import { canManageBilling, readOnlyNotice } from "../../../lib/read-only-notice";
import { getCurrentUser } from "../../../lib/utils";
import {
  FEATURE_MIN_PLAN,
  FeatureKey,
  PARKED_FEATURE_KEYS,
  PLAN_LABELS,
  PLAN_PRICE_EUR,
  PlanId,
} from "../../lib/plans";

interface UpgradeCTAProps {
  feature: FeatureKey;
  plan: PlanId;
  inTrial: boolean;
  /** Override the destination (e.g. when used inside a settings tab). */
  href?: string;
  /**
   * The salon is read-only (cancelled or suspended): the feature is locked
   * because of that, not because of the plan, and the card says so (B13).
   * Without it, a cancelled Pro salon got an empty page: its plan "already
   * includes" the feature, so there was no upgrade to offer.
   */
  readOnly?: { status: string; readOnlyUntil: string | null } | null;
}

/**
 * Inline upsell card shown by `<PlanGate>` (or manually) when the current
 * plan doesn't include a feature. Always links to the billing page where the
 * tenant can upgrade.
 *
 * Parked features (api_access, white_label, custom_branding) are unchanged
 * in the plan matrix but intentionally not offered commercially
 * (rev 3 §4.9). We render no CTA for them so they never surface in the UI.
 */
export function UpgradeCTA({
  feature,
  plan,
  inTrial,
  href = "/dashboard/billing",
  readOnly = null,
}: UpgradeCTAProps) {
  if (PARKED_FEATURE_KEYS.has(feature)) {
    return null;
  }
  if (readOnly) {
    return <ReadOnlyFeatureNotice feature={feature} {...readOnly} />;
  }

  const requiredPlan = FEATURE_MIN_PLAN[feature];
  const alreadyIn = isPlanAtLeast(plan, requiredPlan);
  const price = PLAN_PRICE_EUR[requiredPlan];

  if (alreadyIn) {
    // Feature really is enabled, this CTA should not be visible.
    return null;
  }

  // In the trial (Pro) what is missing is an Empresa feature (B13).
  const headline = upgradeHeadline(PLAN_LABELS[requiredPlan], inTrial, requiredPlan);

  return (
    <div className="rounded-lg border border-dashed border-gray-300 bg-gray-50/60 p-6 text-center">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-violet-100 text-violet-700">
        <Lock className="h-5 w-5" />
      </div>
      <h3 className="text-base font-semibold text-gray-900">
        {humanizeFeature(feature)}
      </h3>
      <p className="mt-1 text-sm text-gray-600">{headline}.</p>
      <p className="mt-1 text-xs text-gray-500">
        Desde <span className="font-semibold">€{price}/mes</span>{" "}
        {/* Empresa is priced per location and works from one. */}
        {requiredPlan === "empresa" && "por local"}
      </p>
      <Link
        href={href}
        className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-violet-700"
      >
        <Sparkles className="h-4 w-4" />
        {plan === "esencial" ? "Mejorar plan" : "Gestionar plan"}
      </Link>
    </div>
  );
}

/** The locked feature of a read-only salon, with the way to Facturación for the owner. */
function ReadOnlyFeatureNotice({
  feature,
  status,
  readOnlyUntil,
}: {
  feature: FeatureKey;
  status: string;
  readOnlyUntil: string | null;
}) {
  // Read after mount (localStorage): only the owner can choose a plan.
  const [role, setRole] = useState<string | null | undefined>(undefined);
  useEffect(() => setRole(getCurrentUser()?.role ?? null), []);
  const notice = readOnlyNotice({
    confirmed: true,
    subscriptionStatus: status,
    readOnlyUntil,
    canManageBilling: canManageBilling(role),
  });
  if (!notice) return null;
  return (
    <div className="rounded-lg border border-dashed border-red-200 bg-red-50/60 p-6 text-center">
      <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-red-100 text-red-700">
        <Lock className="h-5 w-5" />
      </div>
      <h3 className="text-base font-semibold text-gray-900">{humanizeFeature(feature)}</h3>
      <p className="mt-1 text-sm font-medium text-red-900">{notice.title}</p>
      <p className="mt-1 text-sm text-gray-600">{notice.body}</p>
      {notice.cta && (
        <Link
          href="/dashboard/billing"
          className="mt-4 inline-flex items-center gap-1.5 rounded-md bg-red-700 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-red-800"
        >
          {notice.cta}
        </Link>
      )}
    </div>
  );
}

function isPlanAtLeast(current: PlanId, required: PlanId): boolean {
  const order: PlanId[] = ["esencial", "pro", "empresa"];
  return order.indexOf(current) >= order.indexOf(required);
}

function humanizeFeature(feature: FeatureKey): string {
  const map: Record<FeatureKey, string> = {
    whatsapp_notifications: "Recordatorios WhatsApp",
    sms_notifications: "Recordatorios SMS",
    email_marketing: "Email marketing",
    whatsapp_marketing: "Campañas de WhatsApp",
    virtual_receptionist: "Recepcionista IA (Kira)",
    // These five existed in the backend matrix and were missing here, so the
    // CTA had no label for them. Surfaced by unifying FeatureKey in
    // @kira/shared -- exactly the drift that unification is for.
    virtual_receptionist_advanced: "Recepcionista IA avanzada",
    multichannel: "Messenger, Instagram y Telegram",
    google_reviews_auto: "Peticiones de reseña tras la cita",
    copilot_read: "Kira Copilot para el equipo",
    copilot_write: "Kira Copilot con acciones",
    loyalty: "Programa de fidelidad",
    promotions: "Códigos promocionales en caja",
    gift_cards: "Tarjetas regalo",
    wallet: "Wallet de clientas",
    commissions: "Comisiones del equipo",
    multi_location: "Multi-local",
    agenda_shifts: "Turnos y horarios",
    consolidated_reports: "Informes consolidados",
    advanced_analytics: "Analítica avanzada",
    // Parked features are never surfaced via this CTA, but the map is kept
    // typed-exhaustive so the key list locks in sync with `FeatureKey`.
    api_access: "API",
    white_label: "White-label",
    custom_branding: "Branding",
    web_domain: "Web con dominio propio",
  };
  return map[feature] ?? feature;
}
