"use client";

import { rangeLabelKey, rangeOptions, type AnalyticsRange } from "@/lib/analytics-format";
import type { ProfessionalRange, Translate } from "../analytics-types";

const SELECT_CLASS =
  "text-sm border border-gray-300 rounded-lg px-3 py-2 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500";

/**
 * The page's period (Resumen and Clientas): this month, last month, the
 * last 30 days and 3 / 6 / 12 months, as the plan allows. The same presets as
 * Multi-local's consolidated report.
 */
export function PeriodSelector({
  t,
  value,
  maxMonths,
  showPlanNote,
  onChange,
}: {
  t: Translate;
  value: AnalyticsRange;
  maxMonths: number;
  /** "Tu plan muestra hasta N meses", once the plan is known. */
  showPlanNote: boolean;
  onChange: (range: AnalyticsRange) => void;
}) {
  return (
    <div className="flex flex-col items-start sm:items-end">
      <label htmlFor="analytics-period" className="sr-only">
        {t("analytics.period_label")}
      </label>
      <select
        id="analytics-period"
        value={value}
        onChange={(e) => onChange(e.target.value as AnalyticsRange)}
        className={SELECT_CLASS}
      >
        {rangeOptions(maxMonths).map((range) => (
          <option key={range} value={range}>
            {t(rangeLabelKey(range))}
          </option>
        ))}
      </select>
      {showPlanNote && maxMonths < 12 && (
        <p className="text-xs text-gray-400 mt-1">
          {t("analytics.plan_months_note", { months: maxMonths })}
        </p>
      )}
    </div>
  );
}

/** The Profesionales tab's own range (today … 12 months, up to the plan). */
export function ProfessionalRangeSelector({
  t,
  value,
  maxMonths,
  onChange,
}: {
  t: Translate;
  value: ProfessionalRange;
  maxMonths: number;
  onChange: (range: ProfessionalRange) => void;
}) {
  const options: [ProfessionalRange, string][] = [
    ["today", t("analytics.today")],
    ["this_week", t("analytics.this_week")],
    ["last_week", t("analytics.last_week")],
    ["this_month", t("analytics.this_month")],
    ["last_month", t("analytics.last_month")],
    ["3_months", t("analytics.last_3_months")],
  ];
  if (maxMonths >= 6) options.push(["6_months", t("analytics.last_6_months")]);
  if (maxMonths >= 12) options.push(["12_months", t("analytics.last_12_months")]);
  return (
    <>
      <label htmlFor="analytics-professional-range" className="sr-only">
        {t("analytics.professionals_period_label")}
      </label>
      <select
        id="analytics-professional-range"
        value={value}
        onChange={(e) => onChange(e.target.value as ProfessionalRange)}
        className={SELECT_CLASS}
      >
        {options.map(([range, label]) => (
          <option key={range} value={range}>
            {label}
          </option>
        ))}
      </select>
    </>
  );
}
