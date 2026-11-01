"use client";

import type { ReactNode } from "react";
import { ArrowDownRight, ArrowUpRight, Gauge, TrendingUp } from "lucide-react";
import { statusTotal } from "@/lib/analytics-charts";
import { formatDay, formatPercentChange, formatPeriod, formatRate, weekOverWeekChange } from "@/lib/analytics-format";
import type { AppointmentRates, Occupancy, StatusCount, Translate } from "../analytics-types";
import { ChartCard, InfoHint } from "./ui";

/**
 * The period's closing rates as the API measures them (closed appointments
 * up to yesterday, the same definition as the percentage chart and the
 * Profesionales tab), the week-on-week trend and the occupancy.
 */
export function KeyInsights({
  t,
  rates,
  last7,
  last14,
  occupancy,
  period,
}: {
  t: Translate;
  rates?: AppointmentRates;
  last7: StatusCount[];
  last14: StatusCount[];
  occupancy?: Occupancy;
  period?: { start: string; end: string };
}) {
  const weekTrend = weekOverWeekChange(statusTotal(last7), statusTotal(last14));
  const ratesSub = t("analytics.rates_sub", { closed: rates?.closed ?? 0 });
  // The period runs to today; the rates stop at yesterday.
  const ratesThrough =
    rates && period && rates.through >= period.start
      ? t("analytics.rates_through", { day: formatDay(rates.through, { withYear: true }) })
      : null;

  return (
    <ChartCard
      title={t("analytics.key_insights")}
      headingId="analytics-insights-heading"
      aside={<TrendingUp className="w-5 h-5 text-gray-400" aria-hidden />}
      subtitle={
        <p className="text-xs text-gray-500 mt-1 flex items-center gap-1">
          {t("analytics.rates_note")}
          {ratesThrough && <span>({ratesThrough})</span>}
          <InfoHint label={t("analytics.what_counts", { metric: t("analytics.rates") })} text={t("analytics.rates_hint")} />
        </p>
      }
    >
      <dl className="space-y-4">
        <Insight
          tone="bg-green-50"
          valueTone="text-green-600"
          label={t("analytics.completion_rate")}
          sub={ratesSub}
          value={formatRate(rates?.completionRate)}
        />
        <Insight
          tone="bg-red-50"
          valueTone="text-red-600"
          label={t("analytics.cancellation_rate")}
          sub={ratesSub}
          value={formatRate(rates?.cancellationRate)}
        />
        <Insight
          tone="bg-gray-50"
          valueTone="text-gray-600"
          label={t("analytics.no_show_rate")}
          sub={ratesSub}
          value={formatRate(rates?.noShowRate)}
        />
        <Insight
          tone="bg-indigo-50"
          valueTone={weekTrend === null ? "text-gray-500" : weekTrend >= 0 ? "text-green-600" : "text-red-600"}
          label={t("analytics.appointments_trend")}
          sub={t("analytics.last_7_vs_14_days")}
          value={
            weekTrend === null ? (
              "—"
            ) : (
              <span className="flex items-center">
                {weekTrend >= 0 ? (
                  <ArrowUpRight className="w-5 h-5 mr-1" aria-hidden />
                ) : (
                  <ArrowDownRight className="w-5 h-5 mr-1" aria-hidden />
                )}
                {formatPercentChange(weekTrend)}
              </span>
            )
          }
        />
        {/* Working hours vs booked minutes, over the page's period. */}
        <Insight
          tone="bg-sky-50"
          valueTone="text-sky-700"
          label={
            <>
              <Gauge className="w-4 h-4 text-sky-600" aria-hidden />
              {t("analytics.occupancy")}
              <InfoHint
                label={t("analytics.what_counts", { metric: t("analytics.occupancy") })}
                text={t("analytics.occupancy_hint")}
              />
            </>
          }
          sub={occupancy && occupancy.rate === null ? t("analytics.occupancy_no_schedule") : formatPeriod(period)}
          value={formatRate(occupancy?.rate)}
        />
      </dl>
    </ChartCard>
  );
}

function Insight({
  tone,
  valueTone,
  label,
  sub,
  value,
}: {
  tone: string;
  valueTone: string;
  label: ReactNode;
  sub: string;
  value: ReactNode;
}) {
  return (
    <div className={`flex items-center justify-between gap-3 p-4 rounded-lg ${tone}`}>
      <dt>
        <span className="text-sm font-medium text-gray-700 flex items-center gap-1">{label}</span>
        <span className="block text-xs text-gray-500">{sub}</span>
      </dt>
      <dd className={`text-lg font-bold whitespace-nowrap ${valueTone}`}>{value}</dd>
    </div>
  );
}
