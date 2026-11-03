"use client";

import React from "react";
import { LucideIcon, TrendingDown, TrendingUp } from "lucide-react";
import { formatPercentChange } from "@/lib/analytics-format";
import { InfoHint } from "../../analytics/components/ui";

interface DeltaStatCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  /**
   * Period-over-period change in percent (12.5 is "+12,5 %"): green when
   * up, red when down. `null`: there was nothing to compare with, and
   * `noDeltaLabel` says so. Left out: no comparison line at all.
   */
  changePercent?: number | null;
  /** What the change compares with ("vs. mismos días del mes pasado"), or a sub-line. */
  changeLabel?: string;
  /** Shown instead of the change when `changePercent` is null. */
  noDeltaLabel?: string;
  /** What the figure counts, behind an info button (Analítica's texts). */
  hint?: { label: string; text: string };
  iconClassName?: string;
  className?: string;
}

/**
 * A KPI with its change against the previous period. Percentages are
 * written the Spanish way whatever the browser's language ("+12,5 %"); it
 * used toFixed ("+12.5%"), and with no previous period it showed the
 * comparison's label with no figure.
 */
export const DeltaStatCard: React.FC<DeltaStatCardProps> = ({
  title,
  value,
  icon: Icon,
  changePercent,
  changeLabel,
  noDeltaLabel,
  hint,
  iconClassName = "bg-purple-50 text-purple-600",
  className = "",
}) => {
  const hasDelta = typeof changePercent === "number" && Number.isFinite(changePercent);
  const isPositive = hasDelta && (changePercent as number) >= 0;
  const isZero = hasDelta && (changePercent as number) === 0;

  const deltaColor = !hasDelta
    ? "text-gray-400"
    : isZero
      ? "text-gray-500"
      : isPositive
        ? "text-green-600"
        : "text-red-600";

  const DeltaIcon = !hasDelta || isZero ? null : isPositive ? TrendingUp : TrendingDown;

  return (
    <div className={`bg-white rounded-xl border border-gray-200 p-6 ${className}`}>
      <div className="flex items-start justify-between">
        <div className="min-w-0">
          <p className="text-sm font-medium text-gray-500 flex items-center gap-1">
            {title}
            {hint && <InfoHint label={hint.label} text={hint.text} />}
          </p>
          <p className="text-2xl font-bold text-gray-900 mt-1 truncate">{value}</p>
          {hasDelta && (
            <div className={`flex flex-wrap items-center gap-1 mt-2 text-sm ${deltaColor}`}>
              {DeltaIcon && <DeltaIcon className="w-4 h-4" aria-hidden />}
              <span className="font-medium">{formatPercentChange(changePercent)}</span>
              {changeLabel && <span className="text-gray-400 ml-1">{changeLabel}</span>}
            </div>
          )}
          {changePercent === null && noDeltaLabel && (
            <p className="text-sm text-gray-400 mt-2">— {noDeltaLabel}</p>
          )}
          {changePercent === undefined && changeLabel && (
            <p className="text-sm text-gray-400 mt-2">{changeLabel}</p>
          )}
        </div>
        <div className={`p-3 rounded-lg flex-shrink-0 ${iconClassName}`}>
          <Icon className="w-6 h-6" aria-hidden />
        </div>
      </div>
    </div>
  );
};
