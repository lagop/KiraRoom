"use client";

import { ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle } from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { WeeklyDigest, weeklyDate } from "@/lib/console-weekly";

/** "Esta semana" (audit 8 D12): the same content as the Monday email. */
export default function SaasWeeklyPage() {
  const t = useTranslations();
  const [digest, setDigest] = useState<WeeklyDigest | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    apiClient
      .getSaasWeekly()
      .then((d: WeeklyDigest) => setDigest(d))
      .catch(() => setError(true));
  }, []);

  if (error) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 flex items-center gap-3 text-red-700">
        <AlertCircle className="w-5 h-5 shrink-0" />
        {t("saas.weekly.load_error")}
      </div>
    );
  }
  if (!digest) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin w-12 h-12 border-4 border-slate-800 border-t-transparent rounded-full"></div>
      </div>
    );
  }

  const salon = (id: string, name: string) => (
    <Link href={`/saas/tenants/${id}`} className="font-medium text-indigo-700 hover:underline">
      {name}
    </Link>
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t("saas.weekly.title")}</h1>
        <p className="text-gray-500 mt-1">
          {t("saas.weekly.week", { week: digest.week })} · {t("saas.weekly.subtitle")}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 sm:gap-6">
        <Section id="past-due" title={t("saas.weekly.past_due")} count={digest.pastDue.length} empty={t("saas.weekly.empty")}>
          {digest.pastDue.map((r) => (
            <Row key={r.id} left={salon(r.id, r.name)}>
              {t("saas.weekly.past_due_row", { failed: weeklyDate(r.paymentFailedAt), grace: weeklyDate(r.gracePeriodEndsAt) })}
            </Row>
          ))}
        </Section>

        <Section id="trials" title={t("saas.weekly.trials_ending")} count={digest.trialsEnding.length} empty={t("saas.weekly.empty")}>
          {digest.trialsEnding.map((r) => (
            <Row key={r.id} left={salon(r.id, r.name)}>
              {t("saas.weekly.trial_row", { date: weeklyDate(r.trialEnd) })}
              {r.hasSubscription ? ` · ${t("saas.weekly.trial_has_subscription")}` : ""}
            </Row>
          ))}
        </Section>

        <Section id="deletions" title={t("saas.weekly.deletion_requests")} count={digest.deletionRequests.length} empty={t("saas.weekly.empty")}>
          {digest.deletionRequests.map((r) => (
            <Row key={r.id} left={salon(r.id, r.name)}>
              {t("saas.weekly.deletion_row", { date: weeklyDate(r.deletionRequestedAt) })}
            </Row>
          ))}
        </Section>

        <Section id="retention" title={t("saas.weekly.retention")} count={digest.retention.items.length} empty={t("saas.weekly.empty")}>
          {!digest.retention.enabled && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mb-2">{t("saas.weekly.retention_dry_run")}</p>
          )}
          {digest.retention.items.map((r) => (
            <Row key={r.id} left={salon(r.id, r.name)}>
              {r.kind === "warn" ? t("saas.weekly.retention_warn") : t("saas.weekly.retention_anonymize")}
              {r.dueNow ? ` (${t("saas.weekly.retention_tonight")})` : ""} · {t("saas.weekly.retention_row", { date: weeklyDate(r.anonymizeOn) })}
            </Row>
          ))}
        </Section>

        <Section id="ai" title={t("saas.weekly.ai_spend")} count={digest.aiSpend.salons.length} empty={t("saas.weekly.empty")}>
          <p className="text-sm text-gray-700 mb-2">
            {t("saas.weekly.ai_total", { amount: digest.aiSpend.totalUsd.toFixed(2), period: digest.aiSpend.period })}
          </p>
          {digest.aiSpend.salons.map((r) => (
            <Row key={r.id} left={salon(r.id, r.name)}>
              {t("saas.weekly.ai_row", { amount: r.usd.toFixed(2), calls: r.calls })}
            </Row>
          ))}
          {digest.aiSpend.unpricedModels.length > 0 && (
            <p className="text-xs text-gray-500 mt-2">
              {t("saas.weekly.ai_unpriced", { models: digest.aiSpend.unpricedModels.join(", ") })}
            </p>
          )}
        </Section>

        <Section id="onboarding" title={t("saas.weekly.onboarding_stuck")} count={digest.onboardingStuck.length} empty={t("saas.weekly.empty")}>
          {digest.onboardingStuck.map((r) => (
            <Row key={r.id} left={salon(r.id, r.name)}>
              {t("saas.weekly.onboarding_row", { days: r.days })}
            </Row>
          ))}
        </Section>

        <Section id="bugs" title={t("saas.weekly.bug_reports")} count={digest.openBugReports.count} empty={t("saas.weekly.empty")}>
          {digest.openBugReports.latest.map((b) => (
            <Row key={b.id} left={<span className="text-gray-900">{b.subject}</span>}>
              {b.tenantName ? `${b.tenantName} · ` : ""}
              {weeklyDate(b.createdAt)}
            </Row>
          ))}
          {digest.openBugReports.count > 0 && (
            <Link href="/saas/bug-reports" className="inline-block mt-2 text-sm font-medium text-indigo-600 hover:text-indigo-800">
              {t("saas.weekly.bug_reports_all")}
            </Link>
          )}
        </Section>
      </div>

      <p className="text-xs text-gray-400">{t("saas.weekly.excluded_note")}</p>
    </div>
  );
}

function Section({ id, title, count, empty, children }: { id: string; title: string; count: number; empty: string; children: ReactNode }) {
  return (
    <section id={id} className="bg-white rounded-xl border border-gray-200 p-6 scroll-mt-20">
      <h2 className="text-lg font-semibold text-gray-900 mb-3">
        {title} <span className="text-gray-400 font-normal">({count})</span>
      </h2>
      <div className="space-y-2">{children}</div>
      {count === 0 && <p className="text-sm text-gray-400">{empty}</p>}
    </section>
  );
}

function Row({ left, children }: { left: ReactNode; children: ReactNode }) {
  return (
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 text-sm">
      <span className="min-w-0 truncate">{left}</span>
      <span className="text-gray-600 sm:text-right">{children}</span>
    </div>
  );
}
