"use client";

import React from "react";
import { LucideIcon, TrendingDown, TrendingUp } from "lucide-react";

interface DeltaStatCardProps {
  title: string;
  value: string | number;
  icon: LucideIcon;
  /**
   * Optional period-over-period delta in percent (e.g. 12.5 means
   * "+12.5%"). Positive numbers render green, negative red. Pass
   * `undefined` to hide the delta indicator entirely.
   */
  changePercent?: number;
  /**
   * Optional contextual sub-label shown under the value (e.g. "vs.
   * last month").
   */
  changeLabel?: string;
  iconClassName?: string;
  className?: string;
}

/**
 * Enhanced version of the legacy `StatCard` that replaces the
 * free-text `change` prop with a real numeric delta arrow. Used by
 * the dashboard overview to surface period-over-period comparisons
 * pulled from the analytics backend (no more hardcoded "+8%").
 */
export const DeltaStatCard: React.FC<DeltaStatCardProps> = ({
  title,
  value,
  icon: Icon,
  changePercent,
  changeLabel,
  iconClassName = "bg-purple-50 text-purple-600",
  className = "",
}) => {
  const hasDelta = typeof changePercent === "number" && !Number.isNaN(changePercent);
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
          <p className="text-sm font-medium text-gray-500">{title}</p>
          <p className="text-2xl font-bold text-gray-900 mt-1 truncate">{value}</p>
          {hasDelta && (
            <div className={`flex items-center gap-1 mt-2 text-sm ${deltaColor}`}>
              {DeltaIcon && <DeltaIcon className="w-4 h-4" />}
              <span className="font-medium">
                {isPositive ? "+" : ""}
                {Number(changePercent).toFixed(1)}%
              </span>
              {changeLabel && (
                <span className="text-gray-400 ml-1">{changeLabel}</span>
              )}
            </div>
          )}
          {!hasDelta && changeLabel && (
            <p className="text-sm text-gray-400 mt-2">{changeLabel}</p>
          )}
        </div>
        <div className={`p-3 rounded-lg flex-shrink-0 ${iconClassName}`}>
          <Icon className="w-6 h-6" />
        </div>
      </div>
    </div>
  );
};
