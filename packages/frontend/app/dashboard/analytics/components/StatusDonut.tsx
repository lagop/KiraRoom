"use client";

import { PieChart } from "lucide-react";
import { donutSegments } from "@/lib/analytics-charts";
import { formatRate } from "@/lib/analytics-format";
import type { StatusCount, Translate } from "../analytics-types";
import { DONUT_COLORS, statusLabel } from "./status";
import { ChartCard, InlineError } from "./ui";

/** One window's status breakdown as a donut, its total in the middle. */
export function StatusDonut({ t, title, items }: { t: Translate; title: string; items: StatusCount[] }) {
  const { total, segments } = donutSegments(items);
  const legend = segments.map((s) => ({
    ...s,
    label: statusLabel(t, s.name),
    color: DONUT_COLORS[s.name] || "#6b7280",
    rounded: Math.round(s.percentage),
  }));
  return (
    <div className="flex flex-col items-center">
      <h3 className="text-sm font-medium text-gray-700 mb-4">{title}</h3>
      {items.length > 0 ? (
        <>
          <div className="relative w-36 h-36">
            <svg
              className="w-full h-full -rotate-90"
              viewBox="0 0 100 100"
              role="img"
              aria-label={`${title}: ${t("analytics.donut_summary", { total })} ${legend
                .map((s) => `${s.label} ${s.count} (${formatRate(s.rounded)})`)
                .join(", ")}`}
            >
              {legend.map((s) => (
                <circle
                  key={s.name}
                  cx="50"
                  cy="50"
                  r="40"
                  fill="none"
                  stroke={s.color}
                  strokeWidth="14"
                  strokeDasharray={s.dashArray}
                  strokeDashoffset={s.dashOffset}
                  className="transition-all duration-500"
                />
              ))}
            </svg>
            <div className="absolute inset-0 flex flex-col items-center justify-center" aria-hidden>
              <span className="text-2xl font-bold text-gray-900">{total}</span>
              <span className="text-xs text-gray-500">{t("analytics.total")}</span>
            </div>
          </div>
          <ul className="flex flex-wrap justify-center gap-3 mt-4" aria-hidden>
            {legend.map((s) => (
              <li key={s.name} className="flex items-center text-xs">
                <span className="w-2 h-2 rounded-full mr-1" style={{ backgroundColor: s.color }} />
                <span className="text-gray-600">
                  {s.label}: {formatRate(s.rounded)}
                </span>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-gray-500 text-sm">{t("analytics.no_data_available")}</p>
      )}
    </div>
  );
}

/** "Estado de las citas": the last 7 and the last 14 days. */
export function AppointmentStatusCard({
  t,
  last7,
  last14,
  error,
  onRetry,
}: {
  t: Translate;
  last7: StatusCount[];
  last14: StatusCount[];
  error: string | null;
  onRetry: () => void;
}) {
  return (
    <ChartCard
      title={t("analytics.appointment_status")}
      headingId="analytics-status-heading"
      aside={<PieChart className="w-5 h-5 text-gray-400" aria-hidden />}
    >
      {error && <InlineError message={error} retryLabel={t("analytics.retry")} onRetry={onRetry} />}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
        <StatusDonut t={t} title={t("analytics.last_7_days")} items={last7} />
        <StatusDonut t={t} title={t("analytics.last_14_days")} items={last14} />
      </div>
    </ChartCard>
  );
}
