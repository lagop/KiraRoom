"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { CalendarCheck, CheckCircle } from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { WeeklyDigest, WeeklyTone, weeklyAllClear, weeklyCounts } from "@/lib/console-weekly";

const TONES: Record<WeeklyTone, string> = {
  red: "border-red-200 bg-red-50 text-red-700",
  amber: "border-amber-200 bg-amber-50 text-amber-700",
  gray: "border-gray-200 bg-white text-gray-700",
};

/** The "Esta semana" block of the console home (audit 8 D12). */
export default function WeeklySummary() {
  const t = useTranslations();
  const [digest, setDigest] = useState<WeeklyDigest | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    apiClient
      .getSaasWeekly()
      .then((d: WeeklyDigest) => setDigest(d))
      .catch(() => setFailed(true));
  }, []);

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between gap-3 mb-4">
        <h3 className="text-lg font-semibold text-gray-900 flex items-center gap-2">
          <CalendarCheck className="w-5 h-5 text-slate-700" />
          {t("saas.weekly.home_title")}
        </h3>
        <Link href="/saas/weekly" className="text-sm font-medium text-indigo-600 hover:text-indigo-800">
          {t("saas.weekly.home_link")}
        </Link>
      </div>
      {failed ? (
        <p className="text-sm text-red-600">{t("saas.weekly.load_error")}</p>
      ) : !digest ? (
        <div className="h-16 animate-pulse rounded-lg bg-gray-100" />
      ) : (
        <>
          {weeklyAllClear(digest) && (
            <p className="text-sm text-gray-600 mb-3 flex items-center gap-2">
              <CheckCircle className="w-4 h-4 text-indigo-600" />
              {t("saas.weekly.all_clear")}
            </p>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-3">
            {weeklyCounts(digest).map((c) => (
              <Link
                key={c.anchor}
                href={`/saas/weekly#${c.anchor}`}
                className={`rounded-lg border p-3 hover:shadow transition-shadow ${TONES[c.tone]}`}
              >
                <div className="text-xl font-bold">{c.value}</div>
                <div className="text-xs">{t(`saas.weekly.${c.labelKey}`)}</div>
              </Link>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
