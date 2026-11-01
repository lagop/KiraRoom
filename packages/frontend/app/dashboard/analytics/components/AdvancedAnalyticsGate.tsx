"use client";

import { UpgradeCTA } from "@/components/billing/UpgradeCTA";
import { useFeatureAccess } from "@/hooks/useFeatureAccess";

/** The locked Profesionales / Clientas tab: what it holds and the way to Pro. */
export function AdvancedAnalyticsGate({ note }: { note: string }) {
  const { plan, inTrial } = useFeatureAccess("advanced_analytics");
  return (
    <div className="bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200 rounded-xl p-6 sm:p-8 space-y-4">
      <p className="text-sm text-purple-900 text-center">{note}</p>
      <UpgradeCTA feature="advanced_analytics" plan={plan} inTrial={inTrial} href="/dashboard/billing" />
    </div>
  );
}
