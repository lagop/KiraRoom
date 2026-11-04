"use client";

import { TrendingUp, TrendingDown, Minus } from "lucide-react";
import { formatChange } from "@/lib/console-metrics";

interface MetricCardProps {
  title: string;
  value: string | number;
  /** Percent change; null when there is nothing to compare with (shows "—"). */
  change?: number | null;
  changeLabel?: string;
  subtitle?: string;
  icon?: React.ReactNode;
  valueColor?: string;
}

export function MetricCard({
  title,
  value,
  change,
  changeLabel,
  subtitle,
  icon,
  valueColor = "text-gray-900",
}: MetricCardProps) {
  const getTrendIcon = () => {
    if (change === undefined || change === null || change === 0) {
      return <Minus className="w-4 h-4 text-gray-400" />;
    }
    return change > 0 ? (
      <TrendingUp className="w-4 h-4 text-indigo-500" />
    ) : (
      <TrendingDown className="w-4 h-4 text-red-500" />
    );
  };

  const getTrendColor = () => {
    if (change === undefined || change === null || change === 0) return "text-gray-500";
    return change > 0 ? "text-indigo-600" : "text-red-600";
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-sm text-gray-500">{title}</span>
        {icon && <div className="text-gray-400">{icon}</div>}
      </div>
      <div className={`text-2xl font-bold ${valueColor} mb-1`}>
        {typeof value === "number" ? value.toLocaleString("es-ES") : value}
      </div>
      {change !== undefined && (
        <div className="flex items-center space-x-1">
          {getTrendIcon()}
          <span className={`text-sm font-medium ${getTrendColor()}`}>
            {formatChange(change)}
          </span>
          {changeLabel && (
            <span className="text-xs text-gray-400 ml-1">{changeLabel}</span>
          )}
        </div>
      )}
      {subtitle && <p className="text-xs text-gray-400 mt-1">{subtitle}</p>}
    </div>
  );
}

interface GrowthIndicatorProps {
  /** Percent change; null when there is nothing to compare with (shows "—"). */
  value: number | null | undefined;
  suffix?: string;
  label?: string;
}

export function GrowthIndicator({ value, label }: GrowthIndicatorProps) {
  const known = value !== null && value !== undefined && Number.isFinite(value);
  const isPositive = known && (value as number) > 0;
  const isNeutral = !known || value === 0;

  return (
    <div className="flex items-center space-x-1">
      {isNeutral ? (
        <Minus className="w-3 h-3 text-gray-400" />
      ) : isPositive ? (
        <TrendingUp className="w-3 h-3 text-indigo-500" />
      ) : (
        <TrendingDown className="w-3 h-3 text-red-500" />
      )}
      <span className={`text-sm font-medium ${isNeutral ? "text-gray-500" : isPositive ? "text-indigo-600" : "text-red-600"}`}>
        {formatChange(value)}
      </span>
      {label && <span className="text-xs text-gray-400">{label}</span>}
    </div>
  );
}