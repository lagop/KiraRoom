"use client";

import React from "react";
import { donutColor, donutLabelKey } from "@/lib/home-dashboard";
import { useTranslations } from "@/lib/use-translation";

interface StatusSlice {
  /** The appointment status: it decides the slice's colour and its name. */
  status?: string;
  /** The API's English name, only for a status without a translation. */
  name: string;
  count: number;
}

interface StatusDonutProps {
  data: StatusSlice[];
  size?: number;
  thickness?: number;
  className?: string;
}

/**
 * Donut of the appointments by status, with a legend. Colours come from the
 * status (DONUT_COLORS): the API's `color` is a Tailwind class, which as an
 * SVG stroke drew a grey ring with no slices. Names are Analítica's.
 */
export const StatusDonut: React.FC<StatusDonutProps> = ({
  data,
  size = 132,
  thickness = 18,
  className = "",
}) => {
  const t = useTranslations();
  const total = data.reduce((sum, s) => sum + (s.count || 0), 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;

  if (total === 0) {
    return (
      <div
        className={`flex items-center justify-center text-xs text-gray-400 ${className}`}
        style={{ minHeight: size }}
      >
        {t("dashboard.no_data")}
      </div>
    );
  }

  let cumulative = 0;
  const slices = data
    .filter((s) => s.count > 0)
    .map((s) => {
      const fraction = s.count / total;
      const strokeLength = fraction * circumference;
      const offset = cumulative * circumference;
      cumulative += fraction;
      const labelKey = donutLabelKey(s.status);
      return {
        key: s.status ?? s.name,
        label: labelKey ? t(labelKey) : s.name,
        count: s.count,
        strokeLength,
        offset,
        color: donutColor(s.status),
      };
    });

  return (
    <div className={`flex flex-col items-center ${className}`}>
      <div className="relative" style={{ width: size, height: size }}>
        <svg
          viewBox={`0 0 ${size} ${size}`}
          className="transform -rotate-90"
          width={size}
          height={size}
          role="img"
          aria-label={`${t("analytics.appointment_status")}: ${slices.map((s) => `${s.label} ${s.count}`).join(", ")}`}
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="#f3f4f6"
            strokeWidth={thickness}
          />
          {slices.map((s) => (
            <circle
              key={s.key}
              cx={size / 2}
              cy={size / 2}
              r={radius}
              fill="none"
              stroke={s.color}
              strokeWidth={thickness}
              strokeDasharray={`${s.strokeLength} ${circumference - s.strokeLength}`}
              strokeDashoffset={-s.offset}
              strokeLinecap="butt"
              className="transition-all duration-500"
            />
          ))}
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-2xl font-bold text-gray-900 leading-none">{total}</span>
          <span className="text-[10px] uppercase tracking-wide text-gray-500 mt-1">
            {t("analytics.total")}
          </span>
        </div>
      </div>
      <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 mt-3">
        {slices.map((s) => (
          <div key={s.key} className="flex items-center text-xs">
            <span
              className="w-2 h-2 rounded-full mr-1.5 flex-shrink-0"
              style={{ backgroundColor: s.color }}
              aria-hidden
            />
            <span className="text-gray-600">
              {s.label}: <span className="font-medium text-gray-900">{s.count}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
