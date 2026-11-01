"use client";

import { barWidth, describeSeries } from "@/lib/analytics-charts";
import { formatCents } from "@/lib/analytics-format";
import type { ProfessionalPerformance, ProfessionalRange, Translate } from "../analytics-types";
import { ProfessionalRangeSelector } from "./PeriodSelector";
import { Bar, ChartCard, EmptyState, InlineError, LoadingBlock } from "./ui";

const fullName = (p: ProfessionalPerformance) => `${p.firstName ?? ""} ${p.lastName ?? ""}`.trim() || p.name;

/** Profesionales (Pro): revenue per professional over the tab's own range. */
export function ProfessionalsTab({
  t,
  rows,
  loading,
  error,
  range,
  maxMonths,
  onRangeChange,
  onRetry,
}: {
  t: Translate;
  rows: ProfessionalPerformance[] | null;
  loading: boolean;
  error: string | null;
  range: ProfessionalRange;
  maxMonths: number;
  onRangeChange: (range: ProfessionalRange) => void;
  onRetry: () => void;
}) {
  const title = t("analytics.professional_performance");
  const list = rows ?? [];
  const top = list.slice(0, 5);
  const max = Math.max(...list.map((p) => p.revenue), 1);

  return (
    <ChartCard
      title={title}
      headingId="analytics-professionals-heading"
      busy={loading && list.length > 0}
      busyLabel={t("analytics.updating")}
      aside={<ProfessionalRangeSelector t={t} value={range} maxMonths={maxMonths} onChange={onRangeChange} />}
    >
      {error ? (
        <InlineError message={error} retryLabel={t("analytics.retry")} onRetry={onRetry} />
      ) : loading && list.length === 0 ? (
        <LoadingBlock className="h-32" />
      ) : list.length > 0 ? (
        <div className="space-y-6">
          <div
            className="space-y-4"
            role="img"
            aria-label={`${title}: ${describeSeries(top, fullName, (p) => formatCents(p.revenue))}`}
          >
            {top.map((professional) => (
              // Phones: name and amount on one line, the bar under them.
              <div key={professional.id} className="sm:flex sm:items-center">
                <div className="flex items-baseline justify-between gap-3 sm:contents">
                  <span className="min-w-0 truncate text-sm font-medium text-gray-700 sm:w-32 sm:flex-shrink-0">
                    {fullName(professional)}
                  </span>
                  <span className="whitespace-nowrap text-sm font-medium text-gray-900 sm:order-last sm:w-24 sm:flex-shrink-0 sm:text-right">
                    {formatCents(professional.revenue)}
                  </span>
                </div>
                <div className="mt-1 sm:mt-0 sm:mx-4 sm:flex-1">
                  <Bar width={barWidth(professional.revenue, max)} size="h-6" />
                </div>
              </div>
            ))}
          </div>

          <ul className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {list.slice(0, 6).map((professional, index) => (
              <ProfessionalCard key={professional.id} t={t} professional={professional} rank={index + 1} />
            ))}
          </ul>
        </div>
      ) : (
        <EmptyState text={t("analytics.no_professional_data")} />
      )}
    </ChartCard>
  );
}

const RANK_COLORS: Record<number, string> = {
  1: "bg-yellow-100 text-yellow-800 border-yellow-300",
  2: "bg-gray-100 text-gray-700 border-gray-300",
  3: "bg-orange-100 text-orange-800 border-orange-300",
};
const RANK_ICONS: Record<number, string> = { 1: "🥇", 2: "🥈", 3: "🥉" };

function ProfessionalCard({
  t,
  professional,
  rank,
}: {
  t: Translate;
  professional: ProfessionalPerformance;
  rank: number;
}) {
  const name = fullName(professional);
  return (
    <li className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-shadow">
      <div className="flex items-center space-x-4 mb-4">
        <div className="relative flex-shrink-0">
          {professional.profileImage ? (
            <img src={professional.profileImage} alt="" className="w-12 h-12 rounded-full object-cover" />
          ) : (
            <div className="w-12 h-12 rounded-full bg-indigo-100 flex items-center justify-center" aria-hidden>
              <span className="text-lg font-medium text-indigo-600">
                {professional.firstName?.[0]}
                {professional.lastName?.[0]}
              </span>
            </div>
          )}
          <span
            className={`absolute -top-1 -right-1 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border-2 border-white ${
              RANK_COLORS[rank] ?? "bg-gray-50 text-gray-600 border-gray-200"
            }`}
          >
            <span aria-hidden>{RANK_ICONS[rank] ?? `#${rank}`}</span>
            <span className="sr-only">{t("analytics.rank", { rank })}</span>
          </span>
        </div>
        <p className="flex-1 min-w-0 text-sm font-medium text-gray-900 truncate">{name}</p>
      </div>

      <dl className="grid grid-cols-2 gap-3">
        <div className="bg-indigo-50 rounded-lg p-3 text-center flex flex-col-reverse">
          <dt className="text-xs text-indigo-700">{t("analytics.appointments")}</dt>
          <dd className="text-2xl font-bold text-indigo-600">{professional.appointments}</dd>
        </div>
        <div className="bg-green-50 rounded-lg p-3 text-center flex flex-col-reverse">
          <dt className="text-xs text-green-700">{t("analytics.revenue")}</dt>
          <dd className="text-2xl font-bold text-green-600 break-words">{formatCents(professional.revenue)}</dd>
        </div>
      </dl>
    </li>
  );
}
