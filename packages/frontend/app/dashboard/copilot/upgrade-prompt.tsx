"use client";

/**
 * P2A-staff-copilot-sprint15: in-panel upgrade prompt.
 *
 * Rendered when the LLM returns a `tier_blocked` tool result OR when
 * the server returns 403 with code `COPILOT_NOT_IN_PLAN`. Compact,
 * single CTA, no popups — the panel UX is already modal enough.
 *
 * The plans are Esencial, Pro and Empresa: the copilot's reads come with
 * Pro, its actions with Empresa (there is no "Premium"). Facturación is the
 * owner's only, so anyone else is asked to tell her instead of getting a
 * link they cannot use.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { Sparkles, ArrowRight } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";
import { getCurrentUser } from "@/lib/utils";
import { canManageBilling } from "@/lib/read-only-notice";

export interface UpgradePromptProps {
  /** What the user tried to do. Defaults to the plan's own explanation. */
  reason?: string;
  /** The plan that unlocks it: "pro" (the copilot itself) or "premium" (its actions, Empresa). */
  plan?: "pro" | "premium";
  /** Optional explicit URL override. */
  upgradeUrl?: string;
  /** When true, renders a more compact "feature unavailable" badge. */
  compact?: boolean;
}

export function UpgradePrompt({
  reason,
  plan = "premium",
  upgradeUrl = "/dashboard/billing?source=copilot",
  compact = false,
}: UpgradePromptProps) {
  const t = useTranslations();
  const planName = t(`copilot.plans.${plan}`);
  // Read after mount: the role comes from localStorage.
  const [canUpgrade, setCanUpgrade] = useState(false);
  useEffect(() => {
    setCanUpgrade(canManageBilling(getCurrentUser()?.role));
  }, []);

  if (compact) {
    return (
      <div className="inline-flex items-center gap-1.5 text-xs text-purple-700 bg-purple-50 border border-purple-200 rounded-full px-2.5 py-1">
        <Sparkles className="w-3 h-3" />
        <span>{t("copilot.upgrade.only_in", { plan: planName })}</span>
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
            {t("copilot.upgrade.title", { plan: planName })}
          </h4>
          <p className="text-sm text-gray-600 mt-0.5 leading-snug">
            {reason ??
              (plan === "pro"
                ? t("copilot.upgrade.read_reason")
                : t("copilot.upgrade.write_reason"))}
          </p>
          {canUpgrade ? (
            <Link
              href={upgradeUrl}
              className="inline-flex items-center gap-1.5 mt-2.5 px-3 py-1.5 text-xs font-medium text-white bg-purple-600 hover:bg-purple-700 rounded-md"
            >
              {t("copilot.upgrade.cta")}
              <ArrowRight className="w-3 h-3" />
            </Link>
          ) : (
            <p className="mt-2.5 text-xs font-medium text-purple-800">
              {t("copilot.upgrade.ask_owner", { plan: planName })}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
