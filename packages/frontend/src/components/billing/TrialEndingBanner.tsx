"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Clock, X } from "lucide-react";
import { useTenantContext } from "../../hooks/useFeatureAccess";
import { getCurrentUser } from "@/lib/utils";
import { useTranslations } from "@/lib/use-translation";
import {
  TRIAL_BANNER_DISMISS_KEY,
  localDayKey,
  trialBannerDays,
} from "@/lib/trial-banner";

function readDismissedOn(): string | null {
  try {
    return window.localStorage.getItem(TRIAL_BANNER_DISMISS_KEY);
  } catch {
    return null;
  }
}

/**
 * D25: across the dashboard in the last 7 days of the trial, for the owner
 * only (Facturación is hers): how many days are left on the plan she is
 * trying and a link to choose one. Closing it hides it until tomorrow.
 * Facturación has its own trial notice, so it is not repeated there.
 */
export function TrialEndingBanner() {
  const t = useTranslations();
  const ctx = useTenantContext();
  const pathname = usePathname();
  // Role and the dismissed day come from localStorage: read after mount.
  const [role, setRole] = useState<string | null | undefined>(undefined);
  const [dismissedOn, setDismissedOn] = useState<string | null>(null);
  useEffect(() => {
    setRole(getCurrentUser()?.role ?? null);
    setDismissedOn(readDismissedOn());
  }, []);

  if (pathname?.startsWith("/dashboard/billing")) return null;
  const days = trialBannerDays({
    role,
    confirmed: ctx.confirmed,
    inTrial: ctx.inTrial,
    trialEnd: ctx.trialEnd,
    subscribed: ctx.subscribed,
    dismissedOn,
    now: new Date(),
  });
  if (days === null) return null;

  const dismiss = () => {
    const today = localDayKey(new Date());
    setDismissedOn(today);
    try {
      window.localStorage.setItem(TRIAL_BANNER_DISMISS_KEY, today);
    } catch {
      // Private mode or blocked storage: hidden for this visit only.
    }
  };

  const plan = t(`plans.${ctx.effectivePlan}`);
  return (
    <div
      role="status"
      className={`flex flex-col gap-2 border-b px-4 py-3 text-sm sm:flex-row sm:items-center sm:justify-between sm:px-6 ${
        days <= 2
          ? "border-red-200 bg-red-50 text-red-900"
          : "border-amber-200 bg-amber-50 text-amber-900"
      }`}
    >
      <div className="flex items-start gap-3">
        <Clock className="mt-0.5 h-4 w-4 flex-shrink-0" aria-hidden="true" />
        <p>
          <strong className="font-semibold">
            {days === 1
              ? t("trialBanner.lastDay", { plan })
              : t("trialBanner.daysLeft", { days, plan })}
          </strong>{" "}
          {t("trialBanner.body")}
        </p>
      </div>
      <div className="flex items-center gap-2 self-start sm:self-auto">
        <Link
          href="/dashboard/billing"
          className="whitespace-nowrap rounded-md bg-gray-900 px-3 py-1.5 font-medium text-white hover:bg-gray-800"
        >
          {t("trialBanner.cta")}
        </Link>
        <button
          type="button"
          onClick={dismiss}
          className="rounded p-1 opacity-60 hover:opacity-100"
          aria-label={t("trialBanner.dismiss")}
          title={t("trialBanner.dismiss")}
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
