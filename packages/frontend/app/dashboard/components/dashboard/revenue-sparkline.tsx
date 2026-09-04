"use client";

import React, { useMemo } from "react";

interface RevenueSparklineProps {
  /**
   * Daily data points. Each entry is `{ date, revenue }`. The chart
   * will plot `revenue` over time and highlight the last value as the
   * "today" reading.
   */
  data: { date: string; revenue: number }[];
  height?: number;
  className?: string;
}

/**
 * Compact SVG line/area chart for the revenue trend on the dashboard
 * overview. Renders without any third-party chart library.
 *
 * - Computes an upper-bound `max` from the data so the line scales to
 *   the visible range (not hardcoded to 1) and pads the top with a
 *   little headroom so peaks don't kiss the upper edge.
 * - Plots a smooth area fill + a 2px line + dots at each daily point.
 * - Highlights the most recent point with a larger marker.
 */
export const RevenueSparkline: React.FC<RevenueSparklineProps> = ({
  data,
  height = 60,
  className = "",
}) => {
  const padding = { top: 6, right: 4, bottom: 6, left: 4 };

  const { points, areaPath, linePath, lastPoint, width } = useMemo(() => {
    const w = 320; // viewBox width; the SVG scales fluidly via width="100%"
    const h = height;
    if (!data || data.length === 0) {
      return { points: [], areaPath: "", linePath: "", lastPoint: null, width: w };
    }
    const maxRevenue = Math.max(...data.map((d) => d.revenue), 1);
    const minRevenue = Math.min(...data.map((d) => d.revenue), 0);
    const range = Math.max(maxRevenue - minRevenue, 1);
    // Add 15% headroom above max so the line doesn't touch the top.
    const yMax = maxRevenue + range * 0.15;

    const innerW = w - padding.left - padding.right;
    const innerH = h - padding.top - padding.bottom;
    const stepX = data.length > 1 ? innerW / (data.length - 1) : innerW;

    const pts = data.map((d, i) => {
      const x = padding.left + i * stepX;
      const y =
        padding.top +
        innerH -
        ((d.revenue - minRevenue) / (yMax - minRevenue)) * innerH;
      return { x, y, value: d.revenue, date: d.date };
    });

    // Build a smooth path using straight segments — keeps the SVG tiny
    // and works well for ~30 daily points.
    const line = pts
      .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
      .join(" ");

    // Close the area down to the bottom for a gradient fill.
    const area = `${line} L${pts[pts.length - 1].x.toFixed(2)},${(padding.top + innerH).toFixed(2)} L${pts[0].x.toFixed(2)},${(padding.top + innerH).toFixed(2)} Z`;

    return {
      points: pts,
      areaPath: area,
      linePath: line,
      lastPoint: pts[pts.length - 1],
      width: w,
    };
  }, [data, height]);

  if (!data || data.length === 0) {
    return (
      <div
        className={`flex items-center justify-center text-xs text-gray-400 ${className}`}
        style={{ height }}
      >
        No data
      </div>
    );
  }

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      width="100%"
      height={height}
      className={className}
      preserveAspectRatio="none"
      aria-label="Revenue trend"
    >
      <defs>
        <linearGradient id="revSparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#7c3aed" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#7c3aed" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={areaPath} fill="url(#revSparkFill)" />
      <path
        d={linePath}
        fill="none"
        stroke="#7c3aed"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {points.map((p, i) => (
        <circle
          key={i}
          cx={p.x}
          cy={p.y}
          r={i === points.length - 1 ? 3.5 : 1.5}
          fill={i === points.length - 1 ? "#7c3aed" : "#a78bfa"}
          stroke="#fff"
          strokeWidth={i === points.length - 1 ? 1.5 : 0}
        />
      ))}
      {lastPoint && (
        <circle
          cx={lastPoint.x}
          cy={lastPoint.y}
          r={5}
          fill="#7c3aed"
          fillOpacity="0.18"
        />
      )}
    </svg>
  );
};
