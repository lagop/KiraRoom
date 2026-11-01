"use client";

import { useState } from "react";
import {
  EVOLUTION_STATUSES,
  barWidth,
  describeSeries,
  stackedEvolution,
  statusShareSeries,
  type EvolutionStatus,
} from "@/lib/analytics-charts";
import { formatMonth, formatMonthRange, formatRate } from "@/lib/analytics-format";
import type { EvolutionRow, Translate } from "../analytics-types";
import { STATUS_COLORS, statusLabel } from "./status";
import { Bar, ChartCard, EmptyState, InlineError, LoadingBlock } from "./ui";

interface EvolutionProps {
  t: Translate;
  rows: EvolutionRow[];
  /** Translated failure of the latest request, if it failed. */
  error: string | null;
  /** True only while nothing is on screen yet. */
  loading: boolean;
  /** A newer period is loading over the current rows. */
  refreshing: boolean;
  onRetry: () => void;
}

/** Completed, cancelled and no-show appointments month by month, stacked. */
export function StatusEvolution({ t, rows, error, loading, refreshing, onRetry }: EvolutionProps) {
  const columns = stackedEvolution(rows);
  const period = rows.length > 0 ? formatMonthRange(rows[0].period, rows[rows.length - 1].period) : "";
  const title = t("analytics.appointment_status_evolution");

  return (
    <ChartCard
      title={title}
      headingId="analytics-evolution-heading"
      busy={refreshing}
      busyLabel={t("analytics.updating")}
      subtitle={
        <>
          {period && (
            <p className="text-xs text-gray-400 mt-1">
              {t("analytics.period_label")}: {period}
            </p>
          )}
          <ul className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs mt-2" aria-hidden>
            {EVOLUTION_STATUSES.map((status) => (
              <li key={status} className="flex items-center">
                <span className="w-3 h-3 rounded-sm mr-1" style={{ backgroundColor: STATUS_COLORS[status] }} />
                <span className="text-gray-600">{statusLabel(t, status)}</span>
              </li>
            ))}
          </ul>
        </>
      }
    >
      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <InlineError message={error} retryLabel={t("analytics.retry")} onRetry={onRetry} />
      ) : columns.length > 0 ? (
        <>
          {/* The bars for the eye, the table for screen readers. */}
          <div className="flex items-end justify-between h-48 gap-1" aria-hidden>
            {columns.map((column) => (
              <div key={column.period} className="flex-1 flex flex-col justify-end min-w-0">
                <div className="w-full relative h-40">
                  {column.segments.map(
                    (s) =>
                      s.height > 0 && (
                        <div
                          key={s.status}
                          className="w-full absolute"
                          style={{
                            height: `${s.height}%`,
                            bottom: `${s.bottom}%`,
                            backgroundColor: STATUS_COLORS[s.status],
                          }}
                          title={`${statusLabel(t, s.status)}: ${s.count}`}
                        />
                      ),
                  )}
                </div>
                <span
                  className="text-xs text-gray-500 mt-2 truncate max-w-full text-center"
                  title={formatMonth(column.period, { withYear: true })}
                >
                  {formatMonth(column.period)}
                </span>
              </div>
            ))}
          </div>
          <div className="sr-only">
            <table>
              <caption>{title}</caption>
              <thead>
                <tr>
                  <th scope="col">{t("analytics.month")}</th>
                  {EVOLUTION_STATUSES.map((status) => (
                    <th key={status} scope="col">
                      {statusLabel(t, status)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {columns.map((column) => (
                  <tr key={column.period}>
                    <th scope="row">{formatMonth(column.period, { withYear: true })}</th>
                    {column.segments.map((s) => (
                      <td key={s.status}>{s.count}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <EmptyState text={t("analytics.no_evolution_data")} />
      )}
    </ChartCard>
  );
}

/** One status's share of the three, month by month, with a status picker. */
export function StatusPercentage({ t, rows, error, loading, refreshing, onRetry }: EvolutionProps) {
  const [status, setStatus] = useState<EvolutionStatus>("Completed");
  const series = statusShareSeries(rows, status);
  const max = Math.max(...series.map((d) => d.percentage), 1);
  const title = t("analytics.percentage_evolution");

  return (
    <ChartCard title={title} headingId="analytics-percentage-heading" busy={refreshing} busyLabel={t("analytics.updating")}>
      {/* Pills that wrap: three px-4 buttons did not fit a phone. */}
      <div
        role="group"
        aria-label={t("analytics.status_filter_label")}
        className="flex flex-wrap justify-center gap-2 mb-6"
      >
        {EVOLUTION_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            aria-pressed={status === s}
            onClick={() => setStatus(s)}
            className={`rounded-full border px-3 py-1.5 text-sm font-medium transition-colors ${
              status === s ? "text-white border-transparent" : "bg-white text-gray-700 border-gray-300 hover:bg-gray-50"
            }`}
            style={status === s ? { backgroundColor: STATUS_COLORS[s] } : undefined}
          >
            {statusLabel(t, s)}
          </button>
        ))}
      </div>

      {loading ? (
        <LoadingBlock />
      ) : error ? (
        <InlineError message={error} retryLabel={t("analytics.retry")} onRetry={onRetry} />
      ) : series.length > 0 ? (
        <div
          className="space-y-3"
          role="img"
          aria-label={`${title}, ${statusLabel(t, status)}: ${describeSeries(
            series,
            (d) => formatMonth(d.period, { withYear: true }),
            (d) => formatRate(d.percentage),
          )}`}
        >
          {series.map((item) => (
            <div key={item.period} className="flex items-center">
              <span className="w-12 text-xs text-gray-600" title={formatMonth(item.period, { withYear: true })}>
                {formatMonth(item.period)}
              </span>
              <div className="flex-1 mx-3">
                <Bar width={barWidth(item.percentage, max)} color={STATUS_COLORS[status]} size="h-6" square />
              </div>
              <span className="w-16 text-xs font-medium text-gray-900 text-right">{formatRate(item.percentage)}</span>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState text={t("analytics.no_data_available")} />
      )}
    </ChartCard>
  );
}
