"use client";

import Link from "next/link";
import { Lock, Sparkles } from "lucide-react";
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
}: UpgradeCTAProps) {
  if (PARKED_FEATURE_KEYS.has(feature)) {
    return null;
  }

  const requiredPlan = FEATURE_MIN_PLAN[feature];
  const alreadyIn = isPlanAtLeast(plan, requiredPlan);
  const price = PLAN_PRICE_EUR[requiredPlan];

  if (alreadyIn) {
    // Feature really is enabled, this CTA should not be visible.
    return null;
  }

  const headline = inTrial
    ? "Disponible durante tu prueba Pro"
    : `Disponible en el plan ${PLAN_LABELS[requiredPlan]}`;

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
        {requiredPlan === "empresa" && "(mín. 2 locales)"}
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

function isPlanAtLeast(current: PlanId, required: PlanId): boolean {
  const order: PlanId[] = ["esencial", "pro", "empresa"];
  return order.indexOf(current) >= order.indexOf(required);
}

function humanizeFeature(feature: FeatureKey): string {
  const map: Record<FeatureKey, string> = {
    whatsapp_notifications: "Recordatorios WhatsApp",
    sms_notifications: "Recordatorios SMS",
    email_marketing: "Email marketing",
    virtual_receptionist: "Recepcionista IA (Kira)",
    // These five existed in the backend matrix and were missing here, so the
    // CTA had no label for them. Surfaced by unifying FeatureKey in
    // @kira/shared -- exactly the drift that unification is for.
    virtual_receptionist_advanced: "Recepcionista IA avanzada",
    multichannel: "Messenger, Instagram y Telegram",
    google_reviews_auto: "Reseñas automáticas en Google",
    copilot_read: "Kira Copilot para el equipo",
    copilot_write: "Kira Copilot con acciones",
    loyalty: "Programa de fidelidad",
    promotions: "Promociones y cupones",
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
