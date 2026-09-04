"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, Clock, X } from "lucide-react";
import { useTenantContext } from "../../hooks/useFeatureAccess";

/**
 * Banner shown on the dashboard when the tenant is in their 14-day trial.
 * Yellow at 7 days, red at 2 days, urgent CTA at 0.
 */
export function TrialBanner() {
  const ctx = useTenantContext();
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!ctx.inTrial) setDismissed(false);
  }, [ctx.inTrial]);

  if (!ctx.inTrial || dismissed || !ctx.trialEnd) return null;

  const daysRemaining = Math.max(
    0,
    Math.ceil(
      (new Date(ctx.trialEnd).getTime() - Date.now()) / (1000 * 60 * 60 * 24),
    ),
  );

  let bg = "bg-amber-50 border-amber-200 text-amber-900";
  let icon = <Clock className="h-5 w-5 text-amber-700" />;
  let cta = "Elige un plan para no perder nada";

  if (daysRemaining <= 2) {
    bg = "bg-red-50 border-red-200 text-red-900";
    icon = <AlertTriangle className="h-5 w-5 text-red-700" />;
    cta = "Quedan menos de 2 días – elige un plan";
  } else if (daysRemaining <= 7) {
    bg = "bg-amber-50 border-amber-200 text-amber-900";
  }

  return (
    <div
      className={`flex items-start gap-3 rounded-md border px-4 py-3 ${bg}`}
    >
      <div className="mt-0.5">{icon}</div>
      <div className="flex-1 text-sm">
        <p className="font-semibold">
          {daysRemaining > 0
            ? `Te quedan ${daysRemaining} ${
                daysRemaining === 1 ? "día" : "días"
              } de prueba Pro.`
            : "Tu prueba Pro ha terminado."}
        </p>
        <p className="mt-0.5 opacity-90">{cta} y mantén tus datos sin cambios.</p>
        <Link
          href="/dashboard/billing"
          className="mt-1 inline-block font-medium underline"
        >
          Gestionar plan →
        </Link>
      </div>
      <button
        onClick={() => setDismissed(true)}
        className="rounded p-1 opacity-60 hover:opacity-100"
        aria-label="Cerrar"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
