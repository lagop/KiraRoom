"use client";

import { useEffect, useState } from "react";
import { BarChart3, Info, Loader2 } from "lucide-react";
import apiClient from "../../../lib/api";
import { formatCents, formatPeriod, formatRate } from "@/lib/analytics-format";

/**
 * The consolidated report (GET /multi-location/consolidated) existed in the
 * API but nothing in the panel called it. Money arrives in cents; revenue,
 * appointments and occupancy are the same figures as on the Analytics page.
 */

interface Occupancy {
  bookedMinutes: number;
  availableMinutes: number;
  rate: number | null;
  professionalsWithSchedule: number;
}

interface LocationRow {
  locationId: string;
  name: string;
  revenue: number;
  appointments: number;
  completedAppointments: number;
  paidAppointments: number;
  avgTicket: number;
  occupancy: Occupancy;
  professionals: number;
  clients: number;
  topServices: { name: string; count: number; revenue: number }[];
}

interface Report {
  range: string;
  period: { start: string; end: string };
  activeLocations: number;
  totals: {
    revenue: number;
    appointments: number;
    paidAppointments: number;
    avgTicket: number;
    occupancy: Occupancy;
  };
  perLocation: LocationRow[];
  unassigned: { revenue: number; appointments: number };
}

export const CONSOLIDATED_RANGES = [
  "this_month",
  "last_month",
  "last_30_days",
  "3_months",
  "6_months",
  "12_months",
] as const;

type T = (key: string, params?: Record<string, any>) => string;

export function ConsolidatedReport({ t }: { t: T }) {
  const [range, setRange] = useState<string>("this_month");
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    apiClient
      .getConsolidatedReport(range)
      .then((r: Report) => {
        if (!cancelled) setReport(r);
      })
      .catch((e: any) => {
        if (!cancelled) {
          setReport(null);
          setError(e?.message || t("multiLocation.consolidated.loadError"));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range]);

  const occupancyCell = (o: Occupancy) =>
    o.rate === null ? (
      <span className="text-gray-400">{t("multiLocation.consolidated.noSchedule")}</span>
    ) : (
      formatRate(o.rate)
    );

  return (
    <section className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-lg font-semibold text-gray-900">
            <BarChart3 className="h-5 w-5 text-violet-600" />
            {t("multiLocation.consolidated.title")}
          </h2>
          <p className="mt-1 text-sm text-gray-500">
            {t("multiLocation.consolidated.subtitle")}
          </p>
          {report && (
            <p className="mt-1 text-xs text-gray-400">
              {formatPeriod(report.period)}
            </p>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          {t("multiLocation.consolidated.period")}
          <select
            value={range}
            onChange={(e) => setRange(e.target.value)}
            className="rounded-md border border-gray-300 px-2 py-1.5 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
          >
            {CONSOLIDATED_RANGES.map((r) => (
              <option key={r} value={r}>
                {t(`multiLocation.consolidated.${r}`)}
              </option>
            ))}
          </select>
        </label>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 py-8 text-sm text-gray-500">
          <Loader2 className="h-4 w-4 animate-spin" />
          {t("multiLocation.consolidated.loading")}
        </div>
      ) : error || !report ? (
        <p className="py-6 text-sm text-red-600">
          {error || t("multiLocation.consolidated.loadError")}
        </p>
      ) : (
        <>
          <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Kpi
              label={t("multiLocation.consolidated.revenue")}
              value={formatCents(report.totals.revenue)}
              hint={t("multiLocation.consolidated.revenueHint")}
            />
            <Kpi
              label={t("multiLocation.consolidated.appointments")}
              value={String(report.totals.appointments)}
            />
            <Kpi
              label={t("multiLocation.consolidated.avgTicket")}
              value={formatCents(report.totals.avgTicket)}
            />
            <Kpi
              label={t("multiLocation.consolidated.occupancy")}
              value={
                report.totals.occupancy.rate === null
                  ? "—"
                  : formatRate(report.totals.occupancy.rate)
              }
              hint={t("multiLocation.consolidated.occupancyHint")}
            />
          </div>

          <div className="mt-4 overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs uppercase tracking-wide text-gray-500">
                  <th className="py-2 pr-4 font-medium">{t("multiLocation.consolidated.location")}</th>
                  <th className="py-2 pr-4 text-right font-medium">{t("multiLocation.consolidated.revenue")}</th>
                  <th className="py-2 pr-4 text-right font-medium">{t("multiLocation.consolidated.appointments")}</th>
                  <th className="py-2 pr-4 text-right font-medium">{t("multiLocation.consolidated.paid")}</th>
                  <th className="py-2 pr-4 text-right font-medium">{t("multiLocation.consolidated.avgTicket")}</th>
                  <th className="py-2 pr-4 text-right font-medium">{t("multiLocation.consolidated.occupancy")}</th>
                  <th className="py-2 font-medium">{t("multiLocation.consolidated.topServices")}</th>
                </tr>
              </thead>
              <tbody>
                {report.perLocation.map((row) => (
                  <tr key={row.locationId} className="border-b border-gray-100 align-top">
                    <td className="py-2 pr-4 font-medium text-gray-900">{row.name}</td>
                    <td className="py-2 pr-4 text-right">{formatCents(row.revenue)}</td>
                    <td className="py-2 pr-4 text-right">{row.appointments}</td>
                    <td className="py-2 pr-4 text-right">{row.paidAppointments}</td>
                    <td className="py-2 pr-4 text-right">{formatCents(row.avgTicket)}</td>
                    <td className="py-2 pr-4 text-right">{occupancyCell(row.occupancy)}</td>
                    <td className="py-2 text-gray-600">
                      {row.topServices.length === 0
                        ? t("multiLocation.consolidated.noServices")
                        : row.topServices
                            .map((s) => `${s.name} (${s.count})`)
                            .join(", ")}
                    </td>
                  </tr>
                ))}
                {report.unassigned.appointments > 0 && (
                  <tr className="border-b border-gray-100 text-gray-500">
                    <td className="py-2 pr-4" title={t("multiLocation.consolidated.unassignedHint")}>
                      <span className="inline-flex items-center gap-1">
                        {t("multiLocation.consolidated.unassigned")}
                        <Info className="h-3.5 w-3.5" />
                      </span>
                    </td>
                    <td className="py-2 pr-4 text-right">{formatCents(report.unassigned.revenue)}</td>
                    <td className="py-2 pr-4 text-right">{report.unassigned.appointments}</td>
                    <td colSpan={4} className="py-2 text-xs">
                      {t("multiLocation.consolidated.unassignedHint")}
                    </td>
                  </tr>
                )}
                <tr className="font-semibold text-gray-900">
                  <td className="py-2 pr-4">{t("multiLocation.consolidated.total")}</td>
                  <td className="py-2 pr-4 text-right">{formatCents(report.totals.revenue)}</td>
                  <td className="py-2 pr-4 text-right">{report.totals.appointments}</td>
                  <td className="py-2 pr-4 text-right">{report.totals.paidAppointments}</td>
                  <td className="py-2 pr-4 text-right">{formatCents(report.totals.avgTicket)}</td>
                  <td className="py-2 pr-4 text-right">{occupancyCell(report.totals.occupancy)}</td>
                  <td />
                </tr>
              </tbody>
            </table>
          </div>
          <p className="mt-3 text-xs text-gray-500">
            {t("multiLocation.consolidated.attributionNote")}
          </p>
        </>
      )}
    </section>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-md bg-gray-50 p-3" title={hint}>
      <p className="flex items-center gap-1 text-xs text-gray-500">
        {label}
        {hint && <Info className="h-3 w-3" aria-label={hint} />}
      </p>
      <p className="mt-1 text-lg font-semibold text-gray-900">{value}</p>
    </div>
  );
}
