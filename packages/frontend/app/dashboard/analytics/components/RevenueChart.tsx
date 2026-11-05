"use client";

import { Crown } from "lucide-react";
import { barWidth, describeSeries } from "@/lib/analytics-charts";
import { formatCents, formatMonth } from "@/lib/analytics-format";
import type { RevenueDataPoint, Translate } from "../analytics-types";
import { Bar, ChartCard, EmptyState } from "./ui";

/** Revenue month by month, one bar per month of the period. */
export function RevenueChart({
  t,
  rows,
  isAdvanced,
}: {
  t: Translate;
  rows: RevenueDataPoint[];
  isAdvanced: boolean;
}) {
  const title = t("analytics.revenue_overview");
  const max = Math.max(...rows.map((r) => r.revenue), 1);
  return (
    <ChartCard
      title={title}
      headingId="analytics-revenue-heading"
      aside={
        isAdvanced && (
          <span className="px-2 py-1 text-xs bg-purple-100 text-purple-800 rounded-full flex items-center">
            <Crown className="w-3 h-3 mr-1" aria-hidden />
            {t("analytics.pro")}
          </span>
        )
      }
    >
      {rows.length > 0 ? (
        <div
          className="space-y-4"
          role="img"
          aria-label={`${title}: ${describeSeries(
            rows,
            (r) => formatMonth(r.month, { withYear: true }),
            (r) => formatCents(r.revenue),
          )}`}
        >
          {rows.map((row) => (
            <div key={row.month} className="flex items-center">
              <span className="w-12 text-sm text-gray-600" title={formatMonth(row.month, { withYear: true })}>
                {formatMonth(row.month)}
              </span>
              <div className="flex-1 mx-3 sm:mx-4">
                <Bar width={barWidth(row.revenue, max)} size="h-8" />
              </div>
              <span className="w-20 text-sm font-medium text-gray-900 text-right">{formatCents(row.revenue)}</span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState text={t("analytics.no_data_available")} />
      )}
    </ChartCard>
  );
}
