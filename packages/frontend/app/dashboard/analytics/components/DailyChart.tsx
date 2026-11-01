"use client";

import { useState, type PointerEvent } from "react";
import { dailySummary, linePoints, pathFrom } from "@/lib/analytics-charts";
import { formatCents, formatDay } from "@/lib/analytics-format";
import type { DailyPoint, Translate } from "../analytics-types";
import { ChartCard, EmptyState } from "./ui";

type Metric = "revenue" | "appointments";

const W = 300;
const H = 100;
const LINE = "#4f46e5";

/**
 * Revenue or appointments day by day (the overview's dailyMetrics), one
 * measure at a time: euros and appointments do not share an axis.
 */
export function DailyChart({ t, days }: { t: Translate; days: DailyPoint[] }) {
  const [metric, setMetric] = useState<Metric>("revenue");
  const [active, setActive] = useState<number | null>(null);

  const title = t("analytics.daily_evolution");
  const metricLabel = metric === "revenue" ? t("analytics.revenue") : t("analytics.appointments");
  const format = (v: number) => (metric === "revenue" ? formatCents(v) : String(v));
  const values = days.map((d) => d[metric] || 0);
  const max = Math.max(...values, 0);
  const points = linePoints(values, W, H);
  const line = pathFrom(points);
  const area = points.length > 0 ? `${line} L${W},${H} L0,${H} Z` : "";
  const { total, best } = dailySummary(days, metric);
  const first = days[0]?.date;
  const last = days[days.length - 1]?.date;

  const summary = [
    t("analytics.daily_summary", {
      metric: metricLabel,
      start: first ? formatDay(first, { withYear: true }) : "",
      end: last ? formatDay(last, { withYear: true }) : "",
      total: format(total),
    }),
    best ? t("analytics.daily_best_day", { day: formatDay(best.date), value: format(best[metric]) }) : "",
  ]
    .filter(Boolean)
    .join(" ");

  // Position (in percent of the plot) of day i, for the marker.
  const xPct = (i: number) => (days.length > 1 ? (i / (days.length - 1)) * 100 : 50);
  const yPct = (v: number) => (max > 0 ? 100 - (v / max) * 100 : 100);

  const pick = (e: PointerEvent<HTMLDivElement>) => {
    if (days.length === 0) return;
    const box = e.currentTarget.getBoundingClientRect();
    const f = box.width > 0 ? (e.clientX - box.left) / box.width : 0;
    setActive(Math.max(0, Math.min(days.length - 1, Math.round(f * (days.length - 1)))));
  };

  const activeDay = active !== null ? days[active] : null;

  return (
    <ChartCard
      title={title}
      headingId="analytics-daily-heading"
      aside={
        <div role="group" aria-label={t("analytics.daily_metric_label")} className="flex flex-shrink-0 gap-1">
          {(["revenue", "appointments"] as Metric[]).map((m) => (
            <button
              key={m}
              type="button"
              aria-pressed={metric === m}
              onClick={() => setMetric(m)}
              className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${
                metric === m
                  ? "border-indigo-600 bg-indigo-600 text-white"
                  : "border-gray-300 bg-white text-gray-700 hover:bg-gray-50"
              }`}
            >
              {m === "revenue" ? t("analytics.revenue") : t("analytics.appointments")}
            </button>
          ))}
        </div>
      }
    >
      {total > 0 ? (
        <div>
          {/* What is under the finger or the pointer; the summary below is the text version. */}
          <p className="h-5 text-xs text-gray-700 font-medium" aria-hidden>
            {activeDay ? `${formatDay(activeDay.date, { withYear: true })} · ${format(activeDay[metric] || 0)}` : ""}
          </p>
          <div className="flex gap-2">
            <div className="flex flex-col justify-between text-[10px] text-gray-400 text-right w-12 flex-shrink-0" aria-hidden>
              <span>{format(max)}</span>
              <span>{format(0)}</span>
            </div>
            <div
              className="relative h-40 flex-1 touch-pan-y"
              onPointerMove={pick}
              onPointerDown={pick}
              onPointerLeave={() => setActive(null)}
            >
              <svg
                viewBox={`0 0 ${W} ${H}`}
                preserveAspectRatio="none"
                className="absolute inset-0 h-full w-full overflow-visible"
                role="img"
                aria-label={`${title}. ${summary}`}
              >
                <line x1="0" y1={H} x2={W} y2={H} stroke="#e5e7eb" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                <path d={area} fill={LINE} fillOpacity="0.08" />
                <path
                  d={line}
                  fill="none"
                  stroke={LINE}
                  strokeWidth="2"
                  strokeLinejoin="round"
                  strokeLinecap="round"
                  vectorEffect="non-scaling-stroke"
                />
              </svg>
              {activeDay && active !== null && (
                <>
                  <span
                    className="pointer-events-none absolute top-0 bottom-0 w-px bg-gray-300"
                    style={{ left: `${xPct(active)}%` }}
                    aria-hidden
                  />
                  <span
                    className="pointer-events-none absolute h-2.5 w-2.5 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white"
                    style={{
                      left: `${xPct(active)}%`,
                      top: `${yPct(activeDay[metric] || 0)}%`,
                      backgroundColor: LINE,
                    }}
                    aria-hidden
                  />
                </>
              )}
            </div>
          </div>
          <div className="mt-1 flex justify-between pl-14 text-xs text-gray-500" aria-hidden>
            <span>{first ? formatDay(first) : ""}</span>
            <span>{last ? formatDay(last) : ""}</span>
          </div>
          <p className="mt-3 text-xs text-gray-500" aria-hidden>
            {summary}
          </p>
        </div>
      ) : (
        <EmptyState text={t("analytics.no_data_available")} />
      )}
    </ChartCard>
  );
}
