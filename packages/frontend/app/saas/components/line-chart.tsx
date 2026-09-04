"use client";

import { TrendingUp, TrendingDown } from "lucide-react";

interface ChartDataPoint {
  month: string;
  value: number;
  label?: string;
}

interface LineChartProps {
  data: ChartDataPoint[];
  title?: string;
  valuePrefix?: string;
  valueSuffix?: string;
  height?: number;
  color?: string;
}

function formatValue(value: number, prefix = "", suffix = ""): string {
  if (value >= 1000000) {
    return `${prefix}${(value / 1000000).toFixed(1)}M${suffix}`;
  }
  if (value >= 1000) {
    return `${prefix}${(value / 1000).toFixed(1)}K${suffix}`;
  }
  return `${prefix}${value.toFixed(0)}${suffix}`;
}

function formatMonth(monthStr: string): string {
  const [year, month] = monthStr.split("-");
  const date = new Date(parseInt(year), parseInt(month) - 1);
  return date.toLocaleDateString("en-US", { month: "short" });
}

export function LineChart({
  data,
  title,
  valuePrefix = "",
  valueSuffix = "",
  height = 200,
  color = "#6366f1",
}: LineChartProps) {
  if (!data || data.length === 0) {
    return (
      <div className="flex items-center justify-center h-48 text-gray-400">
        No data available
      </div>
    );
  }

  const maxValue = Math.max(...data.map((d) => d.value));
  const minValue = Math.min(...data.map((d) => d.value));
  const range = maxValue - minValue || 1;

  const padding = { top: 20, right: 20, bottom: 40, left: 60 };
  const width = 400;
  const chartWidth = width - padding.left - padding.right;
  const chartHeight = height - padding.top - padding.bottom;

  const getX = (index: number) => padding.left + (index / (data.length - 1)) * chartWidth;
  const getY = (value: number) => padding.top + chartHeight - ((value - minValue) / range) * chartHeight;

  const pathD = data
    .map((d, i) => {
      const x = getX(i);
      const y = getY(d.value);
      return `${i === 0 ? "M" : "L"} ${x} ${y}`;
    })
    .join(" ");

  const areaPathD = `${pathD} L ${getX(data.length - 1)} ${padding.top + chartHeight} L ${padding.left} ${padding.top + chartHeight} Z`;

  const lastValue = data[data.length - 1]?.value || 0;
  const firstValue = data[0]?.value || 0;
  const change = firstValue > 0 ? ((lastValue - firstValue) / firstValue) * 100 : 0;
  const isPositive = change >= 0;

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      {title && (
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-gray-700">{title}</h3>
          <div className={`flex items-center text-sm ${isPositive ? "text-indigo-600" : "text-red-600"}`}>
            {isPositive ? <TrendingUp className="w-4 h-4 mr-1" /> : <TrendingDown className="w-4 h-4 mr-1" />}
            {isPositive ? "+" : ""}{change.toFixed(1)}%
          </div>
        </div>
      )}
      <div className="relative" style={{ height }}>
        <svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
          {[0.25, 0.5, 0.75, 1].map((ratio, i) => {
            const y = padding.top + chartHeight * (1 - ratio);
            const value = minValue + range * ratio;
            return (
              <g key={i}>
                <line
                  x1={padding.left}
                  y1={y}
                  x2={width - padding.right}
                  y2={y}
                  stroke="#e5e7eb"
                  strokeDasharray="4"
                />
                <text x={padding.left - 8} y={y + 4} textAnchor="end" className="text-xs fill-gray-400">
                  {formatValue(value, valuePrefix, valueSuffix)}
                </text>
              </g>
            );
          })}
          <defs>
            <linearGradient id={`gradient-${title}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.3} />
              <stop offset="100%" stopColor={color} stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <path d={areaPathD} fill={`url(#gradient-${title})`} />
          <path d={pathD} fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" />
          {data.map((d, i) => (
            <g key={i}>
              <circle cx={getX(i)} cy={getY(d.value)} r={4} fill={color} stroke="white" strokeWidth={2} />
              <text x={getX(i)} y={height - 8} textAnchor="middle" className="text-xs fill-gray-500">
                {formatMonth(d.month)}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <div className="flex justify-between items-center mt-2 text-sm">
        <span className="text-gray-500">
          {formatValue(firstValue, valuePrefix, valueSuffix)}
        </span>
        <span className="font-medium text-gray-900">
          {formatValue(lastValue, valuePrefix, valueSuffix)}
        </span>
      </div>
    </div>
  );
}