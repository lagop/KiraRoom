/**
 * "Esta semana" in the platform console (audit 8 D12): the shape of
 * GET /saas/weekly (backend saas/weekly/weekly-digest.service.ts) and the
 * counts the home block shows.
 */
export interface WeeklyDigest {
  generatedAt: string;
  week: string;
  pastDue: { id: string; name: string; paymentFailedAt: string | null; gracePeriodEndsAt: string | null }[];
  trialsEnding: { id: string; name: string; trialEnd: string; hasSubscription: boolean }[];
  deletionRequests: { id: string; name: string; deletionRequestedAt: string }[];
  retention: {
    enabled: boolean;
    items: { id: string; name: string; kind: "warn" | "anonymize"; anonymizeOn: string; dueNow: boolean }[];
  };
  aiSpend: {
    period: string;
    totalUsd: number;
    unpricedModels: string[];
    salons: { id: string; name: string; calls: number; outputTokens: number; usd: number }[];
  };
  onboardingStuck: { id: string; name: string; createdAt: string; days: number }[];
  openBugReports: {
    count: number;
    latest: { id: string; subject: string; status: string; createdAt: string; tenantName: string | null }[];
  };
}

export type WeeklyTone = "red" | "amber" | "gray";

export interface WeeklyCount {
  /** i18n key under saas.weekly. */
  labelKey: string;
  value: string;
  /** Anchor of the section on /saas/weekly. */
  anchor: string;
  tone: WeeklyTone;
}

/** One tile per block. Red: money or data at stake now; amber: soon; gray: nothing. */
export function weeklyCounts(d: WeeklyDigest): WeeklyCount[] {
  const n = (count: number, tone: WeeklyTone): WeeklyTone => (count > 0 ? tone : "gray");
  const retentionNow = d.retention.items.filter((r) => r.dueNow).length;
  return [
    { labelKey: "count_past_due", value: String(d.pastDue.length), anchor: "past-due", tone: n(d.pastDue.length, "red") },
    { labelKey: "count_trials", value: String(d.trialsEnding.length), anchor: "trials", tone: n(d.trialsEnding.length, "amber") },
    { labelKey: "count_deletions", value: String(d.deletionRequests.length), anchor: "deletions", tone: n(d.deletionRequests.length, "red") },
    {
      labelKey: "count_retention",
      value: String(d.retention.items.length),
      anchor: "retention",
      tone: n(d.retention.items.length, retentionNow > 0 && d.retention.enabled ? "red" : "amber"),
    },
    { labelKey: "count_ai", value: `${d.aiSpend.totalUsd.toFixed(2)} $`, anchor: "ai", tone: "gray" },
    { labelKey: "count_onboarding", value: String(d.onboardingStuck.length), anchor: "onboarding", tone: n(d.onboardingStuck.length, "amber") },
    { labelKey: "count_bugs", value: String(d.openBugReports.count), anchor: "bugs", tone: n(d.openBugReports.count, "amber") },
  ];
}

/** Nothing to act on (AI spend alone is not a to-do). */
export function weeklyAllClear(d: WeeklyDigest): boolean {
  return (
    d.pastDue.length === 0 &&
    d.trialsEnding.length === 0 &&
    d.deletionRequests.length === 0 &&
    d.retention.items.length === 0 &&
    d.onboardingStuck.length === 0 &&
    d.openBugReports.count === 0
  );
}

/** "9 nov" on the Madrid calendar; a dash when there is no date. */
export function weeklyDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("es-ES", { timeZone: "Europe/Madrid", day: "numeric", month: "short" });
}
