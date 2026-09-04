"use client";

/**
 * P2A-staff-copilot-sprint15: in-panel upgrade prompt.
 *
 * Rendered when the LLM returns a `tier_blocked` tool result OR when
 * the server returns 403 with code `COPILOT_NOT_IN_PLAN`. Compact,
 * single CTA, no popups — the panel UX is already modal enough.
 */

import Link from "next/link";
import { Sparkles, ArrowRight } from "lucide-react";

export interface UpgradePromptProps {
  /**
   * What the user tried to do.
   * Defaults to "acción de escritura" for the free-tier block.
   */
  reason?: string;
  /** The CTA tier name (e.g. "Premium"). */
  tier?: string;
  /** Optional explicit URL override. */
  upgradeUrl?: string;
  /** When true, renders a more compact "feature unavailable" badge. */
  compact?: boolean;
}

export function UpgradePrompt({
  reason,
  tier = "Premium",
  upgradeUrl = "/dashboard/billing?source=copilot",
  compact = false,
}: UpgradePromptProps) {
  if (compact) {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs text-purple-700 bg-purple-50 border border-purple-200 rounded-full px-2.5 py-1">
        <Sparkles className="w-3 h-3" />
        <span>Solo en {tier}</span>
      </div>
    );
  }
  return (
    <div className="bg-gradient-to-r from-purple-50 to-white border border-purple-200 rounded-xl p-4 shadow-sm">
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-full bg-purple-100 flex items-center justify-center shrink-0">
          <Sparkles className="w-4 h-4 text-purple-700" />
        </div>
        <div className="min-w-0 flex-1">
          <h4 className="text-sm font-semibold text-gray-900">
            Esta función solo está en {tier}
          </h4>
          <p className="text-sm text-gray-600 mt-0.5 leading-snug">
            {reason ??
              "Las acciones de escritura (mover citas, enviar WhatsApp, crear cupones) están disponibles en el plan Premium."}
          </p>
          <Link
            href={upgradeUrl}
            className="inline-flex items-center gap-1.5 mt-2.5 px-3 py-1.5 text-xs font-medium text-white bg-purple-600 hover:bg-purple-700 rounded-md"
          >
            Ver planes
            <ArrowRight className="w-3 h-3" />
          </Link>
        </div>
      </div>
    </div>
  );
}
