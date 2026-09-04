"use client";

import React from "react";

interface StatusSlice {
  name: string;
  count: number;
  color?: string;
}

interface StatusDonutProps {
  data: StatusSlice[];
  size?: number;
  thickness?: number;
  className?: string;
}

const STATUS_COLORS: Record<string, string> = {
  Completed: "#10b981", // emerald-500
  Confirmed: "#3b82f6", // blue-500
  Pending: "#eab308", // yellow-500
  Cancelled: "#ef4444", // red-500
  "No Show": "#6b7280", // gray-500
  "In Progress": "#8b5cf6", // violet-500
};

/**
 * Compact donut chart for the appointment status breakdown shown on
 * the dashboard overview.
 *
 * - Slices are computed proportionally and drawn as overlapping
 *   `<circle>` elements with stroke-dasharray offsets (no third-party
 *   chart library).
 * - The center of the donut shows the total count, with the title
 *   configurable.
 * - A legend underneath lists each status with its color and count.
 */
export const StatusDonut: React.FC<StatusDonutProps> = ({
  data,
  size = 132,
  thickness = 18,
  className = "",
}) => {
  const total = data.reduce((sum, s) => sum + (s.count || 0), 0);
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;

  if (total === 0) {
    return (
      <div
        className={`flex items-center justify-center text-xs text-gray-400 ${className}`}
        style={{ minHeight: size }}
      >
        No data
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
      return {
        ...s,
        strokeLength,
        offset,
        color: s.color || STATUS_COLORS[s.name] || "#9ca3af",
      };
    });

  return (
    <div className={`flex flex-col items-center ${className}`}>
      <div
        className="relative"
        style={{ width: size, height: size }}
      >
        <svg
          viewBox={`0 0 ${size} ${size}`}
          className="transform -rotate-90"
          width={size}
          height={size}
          aria-label="Appointment status breakdown"
        >
          <circle
            cx={size / 2}
            cy={size / 2}
            r={radius}
            fill="none"
            stroke="#f3f4f6"
            strokeWidth={thickness}
          />
          {slices.map((s, i) => (
            <circle
              key={i}
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
          <span className="text-2xl font-bold text-gray-900 leading-none">
            {total}
          </span>
          <span className="text-[10px] uppercase tracking-wide text-gray-500 mt-1">
            Total
          </span>
        </div>
      </div>
      <div className="flex flex-wrap justify-center gap-x-3 gap-y-1 mt-3">
        {slices.map((s, i) => (
          <div key={i} className="flex items-center text-xs">
            <span
              className="w-2 h-2 rounded-full mr-1.5 flex-shrink-0"
              style={{ backgroundColor: s.color }}
            />
            <span className="text-gray-600">
              {s.name}:{" "}
              <span className="font-medium text-gray-900">{s.count}</span>
            </span>
          </div>
        ))}
      </div>
    </div>
  );
};
