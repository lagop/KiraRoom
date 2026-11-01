"use client";

import { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import {
  DollarSign,
  TrendingUp,
  Users,
  Calendar,
  BarChart3,
  PieChart,
  ArrowUpRight,
  ArrowDownRight,
  Loader2,
  Crown,
  Star,
  Info,
  Gauge,
  Lock,
  AlertTriangle,
} from "lucide-react";
import apiClient, { ApiError } from "../../../lib/api";
import { useTranslations } from "@/lib/use-translation";
import Link from "next/link";
import { UpgradeCTA } from "@/components/billing/UpgradeCTA";
import { useFeatureAccess } from "@/hooks/useFeatureAccess";
import { getCurrentUser } from "@/lib/utils";
import { isManager } from "@/lib/dashboard-nav";
import {
  formatCents,
  formatMonth,
  formatMonthRange,
  formatPercentChange,
  formatPeriod,
  formatRate,
  periodOptions,
  weekOverWeekChange,
} from "@/lib/analytics-format";

interface DashboardStats {
  totalRevenue: number;
  totalAppointments: number;
  newClients: number;
  avgOrderValue: number;
  /** Percent against the previous period; null when it had nothing to compare with. */
  revenueChange: number | null;
  appointmentsChange: number | null;
  clientsChange: number | null;
  orderValueChange: number | null;
}

interface RevenueDataPoint {
  /** "YYYY-MM" */
  month: string;
  revenue: number;
}

interface ServicePopularity {
  name: string;
  count: number;
  percentage: number;
}

interface AppointmentStatusData {
  name: string;
  count: number;
}

interface StatusEvolution {
  /** "YYYY-MM" */
  period: string;
  Completed: number;
  Cancelled: number;
  "No Show": number;
}

interface ProfessionalPerformance {
  id: string;
  name: string;
  firstName: string;
  lastName: string;
  profileImage: string | null;
  appointments: number;
  revenue: number;
}

interface ClientInsights {
  newClients: number;
  clientsServed: number;
  returningClients: number;
  totalAppointments: number;
  retentionRate: number;
}

/** From /analytics/features: the effective plan (a trial counts as Pro). */
interface AnalyticsFeatureFlags {
  hasAdvancedAnalytics: boolean;
  maxMonths: number;
}

interface Occupancy {
  bookedMinutes: number;
  availableMinutes: number;
  rate: number | null;
  professionalsWithSchedule: number;
}

// Money from the analytics API is in cents (see lib/analytics-format.ts).
interface AnalyticsData {
  period?: { start: string; end: string };
  occupancy?: Occupancy;
  stats: DashboardStats;
  revenueData: RevenueDataPoint[];
  servicePopularity: ServicePopularity[];
}

type StatusType = "Completed" | "Cancelled" | "No Show";
type Tab = "overview" | "professionals" | "clients";

/**
 * What to tell the owner when a request fails. ApiError carries the HTTP
 * status, the server's code and its (Spanish) message; this used to look for
 * an axios-style err.response that never exists, so every failure read as
 * the same generic line.
 */
function errorText(err: unknown, t: (key: string) => string): string {
  if (err instanceof ApiError) {
    if (err.status === 403 && err.code === "FEATURE_NOT_IN_PLAN") {
      return t("analytics.upgrade_required_message");
    }
    // 4xx messages are written for the salon (e.g. "Tu cuenta no está
    // vinculada..."); 5xx ones are not.
    if (err.status >= 400 && err.status < 500 && err.message) return err.message;
  }
  return t("analytics.failed_to_load_data");
}

export default function AnalyticsPage() {
  const t = useTranslations();
  const router = useRouter();

  // Analítica is for whoever runs the salon. Read the role after mount (the
  // server has no token) and send anyone else to the dashboard before any
  // request is made.
  const [role, setRole] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setRole(getCurrentUser()?.role ?? null);
  }, []);
  const manager = isManager(role);
  useEffect(() => {
    if (role !== undefined && !isManager(role)) router.replace("/dashboard");
  }, [role, router]);

  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [features, setFeatures] = useState<AnalyticsFeatureFlags | null>(null);
  const [featuresError, setFeaturesError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<number>(3);
  const [professionalRange, setProfessionalRange] =
    useState<string>("this_month");
  const [activeTab, setActiveTab] = useState<Tab>("overview");
  const [professionalData, setProfessionalData] = useState<
    ProfessionalPerformance[]
  >([]);
  const [clientInsights, setClientInsights] = useState<ClientInsights | null>(
    null,
  );
  const [advancedError, setAdvancedError] = useState<string | null>(null);
  const [advancedLoading, setAdvancedLoading] = useState(false);
  const [statusesEvolution, setStatusesEvolution] = useState<StatusEvolution[]>(
    [],
  );
  const [evolutionError, setEvolutionError] = useState<string | null>(null);
  const [evolutionLoading, setEvolutionLoading] = useState(false);
  const [statusLast7Days, setStatusLast7Days] = useState<
    AppointmentStatusData[]
  >([]);
  const [statusLast14Days, setStatusLast14Days] = useState<
    AppointmentStatusData[]
  >([]);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [selectedStatus, setSelectedStatus] = useState<StatusType>("Completed");

  const maxMonths = features?.maxMonths ?? 3;
  const isAdvanced = !!features?.hasAdvancedAnalytics;

  // Once: the plan does not change with the period. On failure the page
  // says so (and offers a retry) instead of quietly showing Esencial.
  const loadFeatures = async () => {
    try {
      setFeaturesError(false);
      const result = await apiClient.getAnalyticsFeatures();
      setFeatures(result);
      if (result.maxMonths < timeRange) setTimeRange(result.maxMonths);
    } catch (err) {
      console.error("Failed to load features:", err);
      setFeaturesError(true);
    }
  };

  useEffect(() => {
    if (manager) loadFeatures();
  }, [manager]);

  const loadAnalytics = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await apiClient.getAnalyticsOverview(timeRange);
      setData(result);
    } catch (err) {
      console.error("Failed to load analytics:", err);
      setError(errorText(err, t));
      // No sample charts under the error: this used to draw invented
      // revenue that a salon could read as its own.
      setData(null);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (manager) loadAnalytics();
  }, [timeRange, manager]);

  // The evolution follows the selected period (the API cuts it to the plan).
  const loadStatusesEvolution = async () => {
    try {
      setEvolutionLoading(true);
      setEvolutionError(null);
      setStatusesEvolution(
        await apiClient.getAppointmentStatusesEvolution(
          Math.min(timeRange, maxMonths),
        ),
      );
    } catch (err) {
      console.error("Failed to load statuses evolution:", err);
      setEvolutionError(errorText(err, t));
      setStatusesEvolution([]);
    } finally {
      setEvolutionLoading(false);
    }
  };

  useEffect(() => {
    if (manager && features) loadStatusesEvolution();
  }, [timeRange, manager, features?.maxMonths]);

  const loadStatusByDays = async () => {
    try {
      setStatusError(null);
      const [last7, last14] = await Promise.all([
        apiClient.getAppointmentStatusByDays(7),
        apiClient.getAppointmentStatusByDays(14),
      ]);
      setStatusLast7Days(last7);
      setStatusLast14Days(last14);
    } catch (err) {
      console.error("Failed to load status by days:", err);
      setStatusError(errorText(err, t));
      setStatusLast7Days([]);
      setStatusLast14Days([]);
    }
  };

  useEffect(() => {
    if (manager) loadStatusByDays();
  }, [manager]);

  const loadAdvancedData = async (tab: "professionals" | "clients") => {
    try {
      setAdvancedLoading(true);
      setAdvancedError(null);
      if (tab === "professionals") {
        setProfessionalData(
          await apiClient.getProfessionalPerformance(professionalRange),
        );
      } else {
        setClientInsights(await apiClient.getClientInsights(timeRange));
      }
    } catch (err) {
      console.error(`Failed to load ${tab} data:`, err);
      setAdvancedError(errorText(err, t));
    } finally {
      setAdvancedLoading(false);
    }
  };

  useEffect(() => {
    if (activeTab !== "overview" && isAdvanced) loadAdvancedData(activeTab);
  }, [activeTab, timeRange, professionalRange, isAdvanced]);

  const stats = data?.stats;
  const revenueData = data?.revenueData || [];
  const servicePopularity = data?.servicePopularity || [];

  const maxRevenue = Math.max(...revenueData.map((d) => d.revenue), 1);
  const totalAppointments7Days = statusLast7Days.reduce(
    (sum, s) => sum + s.count,
    0,
  );
  const totalAppointments14Days = statusLast14Days.reduce(
    (sum, s) => sum + s.count,
    0,
  );
  /** Share of the last 14 days' appointments in one status, in percent. */
  const shareLast14 = (name: string): number | null => {
    if (totalAppointments14Days <= 0) return null;
    const count = statusLast14Days.find((s) => s.name === name)?.count ?? 0;
    return Math.round((count / totalAppointments14Days) * 100);
  };

  // Status colors
  const statusColors: Record<string, string> = {
    Completed: "#22c55e",
    Cancelled: "#ef4444",
    "No Show": "#6b7280",
  };
  // The donuts show every status, not only the three of the evolution chart.
  const donutColors: Record<string, string> = {
    ...statusColors,
    Confirmed: "#3b82f6",
    Pending: "#eab308",
    "In Progress": "#8b5cf6",
  };
  const weekTrend = weekOverWeekChange(
    totalAppointments7Days,
    totalAppointments14Days,
  );
  const occupancy = data?.occupancy;

  const getStatusLabel = (status: string) => {
    switch (status) {
      case "Completed":
        return t("analytics.completed");
      case "Cancelled":
        return t("analytics.cancelled");
      case "No Show":
        return t("analytics.no_show");
      case "Confirmed":
        return t("analytics.status_confirmed");
      case "Pending":
        return t("analytics.status_pending");
      case "In Progress":
        return t("analytics.status_in_progress");
      default:
        return status;
    }
  };

  /** "+12,5 % vs. mismo período anterior", or "—" when there is nothing to compare. */
  const changeLine = (
    change: number | null | undefined,
  ): { change: string; changeType: "positive" | "negative" | "neutral" } =>
    change === null || change === undefined
      ? { change: `— ${t("analytics.no_previous_data")}`, changeType: "neutral" }
      : {
          change: `${formatPercentChange(change)} ${t("analytics.vs_previous_period")}`,
          changeType: change >= 0 ? "positive" : "negative",
        };

  // Calculate stacked bar chart data - all 3 statuses
  const stackedBarData = statusesEvolution.map((month) => ({
    month: month.period,
    Completed: month.Completed,
    Cancelled: month.Cancelled,
    "No Show": month["No Show"],
  }));

  const maxStackValue = Math.max(
    ...stackedBarData.map((d) => d.Completed + d.Cancelled + d["No Show"]),
    1,
  );
  const evolutionPeriod =
    stackedBarData.length > 0
      ? formatMonthRange(
          stackedBarData[0].month,
          stackedBarData[stackedBarData.length - 1].month,
        )
      : "";

  // Calculate percentage data for selected status
  const percentageData = stackedBarData.map((month) => {
    const total = month.Completed + month.Cancelled + month["No Show"];
    const value = month[selectedStatus];
    return {
      month: month.month,
      percentage: total > 0 ? (value / total) * 100 : 0,
      count: value,
    };
  });

  const maxPercentage = Math.max(...percentageData.map((d) => d.percentage), 1);

  const statusButtonColors: Record<StatusType, string> = {
    Completed: "bg-green-500 hover:bg-green-600",
    Cancelled: "bg-red-500 hover:bg-red-600",
    "No Show": "bg-gray-500 hover:bg-gray-600",
  };

  const periodLabel = (months: number) =>
    months === 12
      ? t("analytics.last_12_months")
      : months === 6
        ? t("analytics.last_6_months")
        : t("analytics.last_3_months");

  if (!manager || (loading && !data && !error)) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
      </div>
    );
  }

  // The Profesionales tab has its own range; the page's period does not
  // apply to it, so its selector and period line are hidden there.
  const showPagePeriod = activeTab !== "professionals";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1
            className="text-2xl font-bold text-gray-900 truncate"
            suppressHydrationWarning
          >
            {t("analytics.title")}
          </h1>
          <p className="text-gray-500 mt-1" suppressHydrationWarning>
            {t("analytics.description")}
          </p>
          {showPagePeriod && data?.period && (
            <p className="text-xs text-gray-400 mt-1">
              {t("analytics.period_label")}: {formatPeriod(data.period)}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {features && !isAdvanced && (
            <Link
              href="/dashboard/billing"
              className="flex items-center px-4 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-lg hover:from-purple-700 hover:to-indigo-700 transition-all"
            >
              <Crown className="w-4 h-4 mr-2" />
              {t("analytics.upgrade_to_pro")}
            </Link>
          )}
          {showPagePeriod && (
            <div className="flex flex-col items-end">
              <select
                value={timeRange}
                onChange={(e) => setTimeRange(Number(e.target.value))}
                aria-label={t("analytics.period_label")}
                className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
              >
                {periodOptions(maxMonths).map((months) => (
                  <option key={months} value={months}>
                    {periodLabel(months)}
                  </option>
                ))}
              </select>
              {features && maxMonths < 12 && (
                <p className="text-xs text-gray-400 mt-1">
                  {t("analytics.plan_months_note", { months: maxMonths })}
                </p>
              )}
            </div>
          )}
        </div>
      </div>

      {featuresError && (
        <InlineError
          message={t("analytics.features_error")}
          retryLabel={t("analytics.retry")}
          onRetry={loadFeatures}
        />
      )}

      {/* Tabs: Pro and Empresa open them; Esencial sees them locked. */}
      {features && (
        <div className="border-b border-gray-200">
          <nav className="flex space-x-8" role="tablist">
            {(
              [
                ["overview", t("analytics.overview"), null],
                ["professionals", t("analytics.professionals"), Star],
                ["clients", t("analytics.clients"), Users],
              ] as const
            ).map(([tab, label, Icon]) => (
              <button
                key={tab}
                role="tab"
                aria-selected={activeTab === tab}
                onClick={() => setActiveTab(tab)}
                className={`py-4 px-1 border-b-2 font-medium text-sm flex items-center transition-colors ${
                  activeTab === tab
                    ? "border-indigo-500 text-indigo-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                }`}
              >
                {Icon && <Icon className="w-4 h-4 mr-1" />}
                {label}
                {tab !== "overview" && !isAdvanced && (
                  <Lock className="w-3.5 h-3.5 ml-1 text-gray-400" aria-hidden />
                )}
              </button>
            ))}
          </nav>
        </div>
      )}

      {/* Overview: only the error when it failed, never zeros that look real. */}
      {activeTab === "overview" && !stats && error && (
        <InlineError
          message={error}
          retryLabel={t("analytics.retry")}
          onRetry={loadAnalytics}
        />
      )}

      {/* Overview Tab */}
      {activeTab === "overview" && stats && (
        <>
          {/* Stats Grid */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              title={t("analytics.total_revenue")}
              value={formatCents(stats.totalRevenue)}
              hint={t("analytics.revenue_hint")}
              icon={DollarSign}
              {...changeLine(stats.revenueChange)}
            />
            <StatCard
              title={t("analytics.total_appointments")}
              value={stats.totalAppointments.toString()}
              hint={t("analytics.appointments_hint")}
              icon={Calendar}
              {...changeLine(stats.appointmentsChange)}
            />
            <StatCard
              title={t("analytics.new_clients")}
              value={stats.newClients.toString()}
              hint={t("analytics.new_clients_hint")}
              icon={Users}
              {...changeLine(stats.clientsChange)}
            />
            <StatCard
              title={t("analytics.avg_order_value")}
              value={formatCents(stats.avgOrderValue)}
              hint={t("analytics.avg_ticket_hint")}
              icon={TrendingUp}
              {...changeLine(stats.orderValueChange)}
            />
          </div>

          {/* Charts Grid - First Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Revenue Chart */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold text-gray-900">
                  {t("analytics.revenue_overview")}
                </h2>
                {isAdvanced && (
                  <span className="px-2 py-1 text-xs bg-purple-100 text-purple-800 rounded-full flex items-center">
                    <Crown className="w-3 h-3 mr-1" />
                    {t("analytics.pro")}
                  </span>
                )}
              </div>
              <div className="space-y-4">
                {revenueData.map((data) => (
                  <div key={data.month} className="flex items-center">
                    <span
                      className="w-12 text-sm text-gray-600"
                      title={formatMonth(data.month, { withYear: true })}
                    >
                      {formatMonth(data.month)}
                    </span>
                    <div className="flex-1 mx-4">
                      <div className="h-8 bg-gray-100 rounded-full overflow-hidden">
                        <div
                          className="h-full bg-indigo-600 rounded-full transition-all duration-500"
                          style={{
                            width: `${(data.revenue / maxRevenue) * 100}%`,
                          }}
                        />
                      </div>
                    </div>
                    <span className="w-20 text-sm font-medium text-gray-900 text-right">
                      {formatCents(data.revenue)}
                    </span>
                  </div>
                ))}
              </div>
            </div>

            {/* Service Popularity */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold text-gray-900">
                  {t("analytics.service_popularity")}
                </h2>
                <BarChart3 className="w-5 h-5 text-gray-400" />
              </div>
              <div className="space-y-4">
                {servicePopularity.map((service, index) => (
                  <div key={index}>
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium text-gray-700">
                        {service.name}
                      </span>
                      <span className="text-sm text-gray-500">
                        {service.count} {t("analytics.appointments")}
                      </span>
                    </div>
                    <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                      <div
                        className="h-full bg-indigo-600 rounded-full transition-all duration-500"
                        style={{ width: `${service.percentage}%` }}
                      />
                    </div>
                  </div>
                ))}
                {servicePopularity.length === 0 && (
                  <p className="text-gray-500 text-center py-4">
                    {t("analytics.no_data_available")}
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Charts Grid - Second Row: Appointment Status Evolution + % Evolution */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Appointment Status Evolution - Half Width */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="mb-6">
                <h2 className="text-lg font-semibold text-gray-900">
                  {t("analytics.appointment_status_evolution")}
                </h2>
                {evolutionPeriod && (
                  <p className="text-xs text-gray-400 mt-1">
                    {t("analytics.period_label")}: {evolutionPeriod}
                  </p>
                )}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs mt-2">
                  {Object.entries(statusColors).map(([status, color]) => (
                    <div key={status} className="flex items-center">
                      <span
                        className="w-3 h-3 rounded-sm mr-1"
                        style={{ backgroundColor: color }}
                      />
                      <span className="text-gray-600">
                        {getStatusLabel(status)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>

              {evolutionLoading ? (
                <div className="flex items-center justify-center h-48">
                  <Loader2 className="w-6 h-6 animate-spin text-indigo-600" />
                </div>
              ) : evolutionError ? (
                <InlineError
                  message={evolutionError}
                  retryLabel={t("analytics.retry")}
                  onRetry={loadStatusesEvolution}
                />
              ) : stackedBarData.length > 0 ? (
                <div className="flex items-end justify-between h-48 gap-1">
                  {/* One slot per month the API returned (the plan's months). */}
                  {stackedBarData.map((monthData) => {
                    const completedHeight =
                      (monthData.Completed / maxStackValue) * 100;
                    const cancelledHeight =
                      (monthData.Cancelled / maxStackValue) * 100;
                    const noShowHeight =
                      (monthData["No Show"] / maxStackValue) * 100;

                    return (
                      <div
                        key={monthData.month}
                        className="flex-1 flex flex-col justify-end"
                      >
                        <div className="w-full relative h-40">
                          {/* Stack bars from bottom - using absolute positioning to ensure they start from bottom */}
                          {completedHeight > 0 && (
                            <div
                              className="w-full absolute bottom-0"
                              style={{
                                height: `${completedHeight}%`,
                                backgroundColor: statusColors["Completed"],
                              }}
                              title={`${t("analytics.completed")}: ${monthData.Completed}`}
                            />
                          )}
                          {cancelledHeight > 0 && (
                            <div
                              className="w-full absolute"
                              style={{
                                height: `${cancelledHeight}%`,
                                bottom: `${completedHeight}%`,
                                backgroundColor: statusColors["Cancelled"],
                              }}
                              title={`${t("analytics.cancelled")}: ${monthData.Cancelled}`}
                            />
                          )}
                          {noShowHeight > 0 && (
                            <div
                              className="w-full absolute"
                              style={{
                                height: `${noShowHeight}%`,
                                bottom: `${completedHeight + cancelledHeight}%`,
                                backgroundColor: statusColors["No Show"],
                              }}
                              title={`${t("analytics.no_show")}: ${monthData["No Show"]}`}
                            />
                          )}
                        </div>
                        <span
                          className="text-xs text-gray-500 mt-2 truncate max-w-full text-center"
                          title={formatMonth(monthData.month, { withYear: true })}
                        >
                          {formatMonth(monthData.month)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="text-gray-500 text-center py-8">
                  {t("analytics.no_evolution_data")}
                </p>
              )}
            </div>

            {/* Status Percentage Evolution - With Button Group */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-4">
                <h2 className="text-lg font-semibold text-gray-900">
                  {t("analytics.percentage_evolution")}
                </h2>
              </div>

              {/* Button Group */}
              <div className="flex justify-center mb-6">
                <div className="inline-flex rounded-lg overflow-hidden border border-gray-200">
                  {(["Completed", "Cancelled", "No Show"] as StatusType[]).map(
                    (status) => (
                      <button
                        key={status}
                        onClick={() => setSelectedStatus(status)}
                        className={`px-4 py-2 text-sm font-medium transition-colors ${
                          selectedStatus === status
                            ? `${statusButtonColors[status]} text-white`
                            : "bg-white text-gray-700 hover:bg-gray-50"
                        }`}
                      >
                        {getStatusLabel(status)}
                      </button>
                    ),
                  )}
                </div>
              </div>

              {/* Percentage Chart */}
              {evolutionError ? (
                <InlineError
                  message={evolutionError}
                  retryLabel={t("analytics.retry")}
                  onRetry={loadStatusesEvolution}
                />
              ) : percentageData.length > 0 ? (
                <div className="space-y-3">
                  {percentageData.map((item) => (
                    <div key={item.month} className="flex items-center">
                      <span
                        className="w-12 text-xs text-gray-600"
                        title={formatMonth(item.month, { withYear: true })}
                      >
                        {formatMonth(item.month)}
                      </span>
                      <div className="flex-1 mx-3">
                        <div className="h-6 bg-gray-100 rounded-sm overflow-hidden">
                          <div
                            className="h-full rounded-sm transition-all duration-500"
                            style={{
                              width: `${(item.percentage / maxPercentage) * 100}%`,
                              backgroundColor: statusColors[selectedStatus],
                            }}
                          />
                        </div>
                      </div>
                      <span className="w-16 text-xs font-medium text-gray-900 text-right">
                        {formatRate(item.percentage)}
                      </span>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-gray-500 text-center py-8">
                  {t("analytics.no_data_available")}
                </p>
              )}
            </div>
          </div>

          {/* Charts Grid - Third Row: Current Appointments + Key Insights */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Current Appointment Status - Donut Charts for 7 and 14 days */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold text-gray-900">
                  {t("analytics.appointment_status")}
                </h2>
                <PieChart className="w-5 h-5 text-gray-400" />
              </div>

              {statusError && (
                <InlineError
                  message={statusError}
                  retryLabel={t("analytics.retry")}
                  onRetry={loadStatusByDays}
                />
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                {/* Last 7 Days */}
                <div className="flex flex-col items-center">
                  <h3 className="text-sm font-medium text-gray-700 mb-4">
                    {t("analytics.last_7_days")}
                  </h3>
                  {statusLast7Days.length > 0 ? (
                    <>
                      <div className="relative w-36 h-36">
                        <svg
                          className="w-full h-full transform -rotate-90"
                          viewBox="0 0 100 100"
                        >
                          {statusLast7Days.map((status, index) => {
                            const percentage =
                              totalAppointments7Days > 0
                                ? (status.count / totalAppointments7Days) * 100
                                : 0;
                            let cumulativePercentage = 0;
                            for (let i = 0; i < index; i++) {
                              cumulativePercentage +=
                                (statusLast7Days[i].count /
                                  totalAppointments7Days) *
                                100;
                            }
                            const strokeDashoffset =
                              251.2 - (cumulativePercentage / 100) * 251.2;
                            const strokeDasharray = (percentage / 100) * 251.2;
                            const color =
                              donutColors[status.name] || "#6b7280";

                            return (
                              <circle
                                key={index}
                                cx="50"
                                cy="50"
                                r="40"
                                fill="none"
                                stroke={color}
                                strokeWidth="14"
                                strokeDasharray={`${strokeDasharray} ${251.2 - strokeDasharray}`}
                                strokeDashoffset={strokeDashoffset}
                                className="transition-all duration-500"
                              />
                            );
                          })}
                        </svg>
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                          <span className="text-2xl font-bold text-gray-900">
                            {totalAppointments7Days}
                          </span>
                          <span className="text-xs text-gray-500">
                            {t("analytics.total")}
                          </span>
                        </div>
                      </div>
                      <div className="flex flex-wrap justify-center gap-3 mt-4">
                        {statusLast7Days.map((status, index) => {
                          const percentage =
                            totalAppointments7Days > 0
                              ? Math.round(
                                  (status.count / totalAppointments7Days) * 100,
                                )
                              : 0;
                          const color = donutColors[status.name] || "#6b7280";
                          return (
                            <div
                              key={index}
                              className="flex items-center text-xs"
                            >
                              <span
                                className="w-2 h-2 rounded-full mr-1"
                                style={{ backgroundColor: color }}
                              />
                              <span className="text-gray-600">
                                {getStatusLabel(status.name)}: {formatRate(percentage)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <p className="text-gray-500 text-sm">
                      {t("analytics.no_data_available")}
                    </p>
                  )}
                </div>

                {/* Last 14 Days */}
                <div className="flex flex-col items-center">
                  <h3 className="text-sm font-medium text-gray-700 mb-4">
                    {t("analytics.last_14_days")}
                  </h3>
                  {statusLast14Days.length > 0 ? (
                    <>
                      <div className="relative w-36 h-36">
                        <svg
                          className="w-full h-full transform -rotate-90"
                          viewBox="0 0 100 100"
                        >
                          {statusLast14Days.map((status, index) => {
                            const percentage =
                              totalAppointments14Days > 0
                                ? (status.count / totalAppointments14Days) * 100
                                : 0;
                            let cumulativePercentage = 0;
                            for (let i = 0; i < index; i++) {
                              cumulativePercentage +=
                                (statusLast14Days[i].count /
                                  totalAppointments14Days) *
                                100;
                            }
                            const strokeDashoffset =
                              251.2 - (cumulativePercentage / 100) * 251.2;
                            const strokeDasharray = (percentage / 100) * 251.2;
                            const color =
                              donutColors[status.name] || "#6b7280";

                            return (
                              <circle
                                key={index}
                                cx="50"
                                cy="50"
                                r="40"
                                fill="none"
                                stroke={color}
                                strokeWidth="14"
                                strokeDasharray={`${strokeDasharray} ${251.2 - strokeDasharray}`}
                                strokeDashoffset={strokeDashoffset}
                                className="transition-all duration-500"
                              />
                            );
                          })}
                        </svg>
                        <div className="absolute inset-0 flex flex-col items-center justify-center">
                          <span className="text-2xl font-bold text-gray-900">
                            {totalAppointments14Days}
                          </span>
                          <span className="text-xs text-gray-500">
                            {t("analytics.total")}
                          </span>
                        </div>
                      </div>
                      <div className="flex flex-wrap justify-center gap-3 mt-4">
                        {statusLast14Days.map((status, index) => {
                          const percentage =
                            totalAppointments14Days > 0
                              ? Math.round(
                                  (status.count / totalAppointments14Days) *
                                    100,
                                )
                              : 0;
                          const color = donutColors[status.name] || "#6b7280";
                          return (
                            <div
                              key={index}
                              className="flex items-center text-xs"
                            >
                              <span
                                className="w-2 h-2 rounded-full mr-1"
                                style={{ backgroundColor: color }}
                              />
                              <span className="text-gray-600">
                                {getStatusLabel(status.name)}: {formatRate(percentage)}
                              </span>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  ) : (
                    <p className="text-gray-500 text-sm">
                      {t("analytics.no_data_available")}
                    </p>
                  )}
                </div>
              </div>
            </div>

            {/* Key Insights */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold text-gray-900">
                  {t("analytics.key_insights")}
                </h2>
                <TrendingUp className="w-5 h-5 text-gray-400" />
              </div>

              <div className="space-y-4">
                {/* Insight 1: Completion Rate */}
                <div className="flex items-center justify-between p-4 bg-green-50 rounded-lg">
                  <div>
                    <p className="text-sm font-medium text-gray-700">
                      {t("analytics.completion_rate")}
                    </p>
                    <p className="text-xs text-gray-500">
                      {t("analytics.last_14_days")}
                    </p>
                  </div>
                  <span className="text-lg font-bold text-green-600">
                    {formatRate(shareLast14("Completed"))}
                  </span>
                </div>

                {/* Insight 2: Cancellation Rate */}
                <div className="flex items-center justify-between p-4 bg-red-50 rounded-lg">
                  <div>
                    <p className="text-sm font-medium text-gray-700">
                      {t("analytics.cancellation_rate")}
                    </p>
                    <p className="text-xs text-gray-500">
                      {t("analytics.last_14_days")}
                    </p>
                  </div>
                  <span className="text-lg font-bold text-red-600">
                    {formatRate(shareLast14("Cancelled"))}
                  </span>
                </div>

                {/* Insight 3: No Show Rate */}
                <div className="flex items-center justify-between p-4 bg-gray-50 rounded-lg">
                  <div>
                    <p className="text-sm font-medium text-gray-700">
                      {t("analytics.no_show_rate")}
                    </p>
                    <p className="text-xs text-gray-500">
                      {t("analytics.last_14_days")}
                    </p>
                  </div>
                  <span className="text-lg font-bold text-gray-600">
                    {formatRate(shareLast14("No Show"))}
                  </span>
                </div>

                {/* Insight 4: Total Appointments Trend */}
                <div className="flex items-center justify-between p-4 bg-indigo-50 rounded-lg">
                  <div>
                    <p className="text-sm font-medium text-gray-700">
                      {t("analytics.appointments_trend")}
                    </p>
                    <p className="text-xs text-gray-500">
                      {t("analytics.last_7_vs_14_days")}
                    </p>
                  </div>
                  <div className="flex items-center">
                    {weekTrend === null ? (
                      <span className="text-lg font-bold text-gray-500">—</span>
                    ) : (
                      <>
                        {weekTrend >= 0 ? (
                          <ArrowUpRight className="w-5 h-5 text-green-600 mr-1" />
                        ) : (
                          <ArrowDownRight className="w-5 h-5 text-red-600 mr-1" />
                        )}
                        <span
                          className={`text-lg font-bold ${weekTrend >= 0 ? "text-green-600" : "text-red-600"}`}
                        >
                          {formatPercentChange(weekTrend)}
                        </span>
                      </>
                    )}
                  </div>
                </div>

                {/* Insight 5: Occupancy (working hours vs booked minutes) */}
                <div
                  className="flex items-center justify-between p-4 bg-sky-50 rounded-lg"
                  title={t("analytics.occupancy_hint")}
                >
                  <div>
                    <p className="text-sm font-medium text-gray-700 flex items-center gap-1">
                      <Gauge className="w-4 h-4 text-sky-600" />
                      {t("analytics.occupancy")}
                      <Info
                        className="w-3.5 h-3.5 text-gray-400"
                        aria-label={t("analytics.occupancy_hint")}
                      />
                    </p>
                    <p className="text-xs text-gray-500">
                      {occupancy && occupancy.rate === null
                        ? t("analytics.occupancy_no_schedule")
                        : formatPeriod(data?.period)}
                    </p>
                  </div>
                  <span className="text-lg font-bold text-sky-700">
                    {formatRate(occupancy?.rate)}
                  </span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* Professionals Tab (Advanced) */}
      {activeTab === "professionals" && isAdvanced && (
        <div className="space-y-6">
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-6">
              <h2 className="text-lg font-semibold text-gray-900">
                {t("analytics.professional_performance")}
              </h2>
              <div className="flex items-center space-x-3">
                <select
                  value={professionalRange}
                  onChange={(e) => setProfessionalRange(e.target.value)}
                  aria-label={t("analytics.period_label")}
                  className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                >
                  <option value="today">{t("analytics.today")}</option>
                  <option value="this_week">{t("analytics.this_week")}</option>
                  <option value="last_week">{t("analytics.last_week")}</option>
                  <option value="this_month">
                    {t("analytics.this_month")}
                  </option>
                  <option value="last_month">
                    {t("analytics.last_month")}
                  </option>
                  <option value="3_months">
                    {t("analytics.last_3_months")}
                  </option>
                  {maxMonths >= 6 && (
                    <option value="6_months">
                      {t("analytics.last_6_months")}
                    </option>
                  )}
                  {maxMonths >= 12 && (
                    <option value="12_months">
                      {t("analytics.last_12_months")}
                    </option>
                  )}
                </select>
              </div>
            </div>

            {advancedError ? (
              <InlineError
                message={advancedError}
                retryLabel={t("analytics.retry")}
                onRetry={() => loadAdvancedData("professionals")}
              />
            ) : advancedLoading && professionalData.length === 0 ? (
              <div className="flex items-center justify-center h-32">
                <Loader2 className="w-6 h-6 animate-spin text-indigo-600" />
              </div>
            ) : professionalData.length > 0 ? (
              <div className="space-y-6">
                <div className="space-y-4">
                  {professionalData.slice(0, 5).map((professional) => (
                    <div key={professional.id} className="flex items-center">
                      <span className="w-32 text-sm font-medium text-gray-700 truncate">
                        {professional.firstName} {professional.lastName}
                      </span>
                      <div className="flex-1 mx-4">
                        <div className="h-6 bg-gray-100 rounded-full overflow-hidden">
                          <div
                            className="h-full bg-indigo-600 rounded-full transition-all duration-500"
                            style={{
                              width: `${(professional.revenue / Math.max(...professionalData.map((p) => p.revenue), 1)) * 100}%`,
                            }}
                          />
                        </div>
                      </div>
                      <span className="w-24 text-sm font-medium text-gray-900 text-right">
                        {formatCents(professional.revenue)}
                      </span>
                    </div>
                  ))}
                </div>

                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 mt-6">
                  {professionalData.slice(0, 6).map((professional, index) => (
                    <ProfessionalCard
                      key={professional.id}
                      professional={professional}
                      rank={index + 1}
                      t={t}
                    />
                  ))}
                </div>
              </div>
            ) : (
              <p className="text-gray-500 text-center py-8">
                {t("analytics.no_professional_data")}
              </p>
            )}
          </div>
        </div>
      )}

      {/* Clients Tab (Advanced) */}
      {activeTab === "clients" && isAdvanced && (
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-6">
            {t("analytics.client_insights")}
          </h2>

          {advancedError ? (
            <InlineError
              message={advancedError}
              retryLabel={t("analytics.retry")}
              onRetry={() => loadAdvancedData("clients")}
            />
          ) : advancedLoading && !clientInsights ? (
            <div className="flex items-center justify-center h-32">
              <Loader2 className="w-6 h-6 animate-spin text-indigo-600" />
            </div>
          ) : clientInsights ? (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <div className="bg-indigo-50 rounded-lg p-6">
                <div className="flex items-center justify-between mb-2">
                  <Users className="w-5 h-5 text-indigo-600" />
                  <span className="text-xs bg-indigo-100 text-indigo-800 px-2 py-1 rounded-full">
                    {t("analytics.new")}
                  </span>
                </div>
                <p className="text-3xl font-bold text-gray-900">
                  {clientInsights.newClients}
                </p>
                <p className="text-sm text-gray-600">
                  {t("analytics.new_clients")}
                </p>
              </div>

              {/* Recurring = served in the period (≥1 completed appointment)
                  and came back within it or had come before. Computed by
                  the API from appointment history (clientRetention). */}
              <div
                className="bg-blue-50 rounded-lg p-6"
                title={t("analytics.returning_hint")}
              >
                <div className="flex items-center justify-between mb-2">
                  <Star className="w-5 h-5 text-blue-600" />
                  <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full">
                    {t("analytics.returning")}
                  </span>
                </div>
                <p className="text-3xl font-bold text-gray-900">
                  {clientInsights.returningClients}
                  <span className="text-base font-normal text-gray-500">
                    {" "}
                    / {clientInsights.clientsServed}
                  </span>
                </p>
                <p className="text-sm text-gray-600 flex items-center gap-1">
                  {t("analytics.returning_clients")}
                  <Info className="w-3.5 h-3.5 text-gray-400" />
                </p>
                <p className="text-xs text-gray-500 mt-2">
                  {t("analytics.returning_hint")}
                </p>
              </div>

              <div
                className="bg-green-50 rounded-lg p-6"
                title={t("analytics.clients_served_hint")}
              >
                <div className="flex items-center justify-between mb-2">
                  <Calendar className="w-5 h-5 text-green-600" />
                </div>
                <p className="text-3xl font-bold text-gray-900">
                  {clientInsights.clientsServed}
                </p>
                <p className="text-sm text-gray-600 flex items-center gap-1">
                  {t("analytics.clients_served")}
                  <Info className="w-3.5 h-3.5 text-gray-400" />
                </p>
                <p className="text-xs text-gray-500 mt-2">
                  {clientInsights.totalAppointments}{" "}
                  {t("analytics.appointments").toLowerCase()}
                </p>
              </div>

              <div
                className="bg-purple-50 rounded-lg p-6"
                title={t("analytics.retention_hint")}
              >
                <div className="flex items-center justify-between mb-2">
                  <TrendingUp className="w-5 h-5 text-purple-600" />
                </div>
                <p className="text-3xl font-bold text-gray-900">
                  {formatRate(clientInsights.retentionRate)}
                </p>
                <p className="text-sm text-gray-600 flex items-center gap-1">
                  {t("analytics.retention_rate")}
                  <Info className="w-3.5 h-3.5 text-gray-400" />
                </p>
                <p className="text-xs text-gray-500 mt-2">
                  {t("analytics.retention_hint")}
                </p>
              </div>
            </div>
          ) : (
            <p className="text-gray-500 text-center py-8">
              {t("analytics.no_client_insights")}
            </p>
          )}
        </div>
      )}

      {/* Esencial: the tabs are shown locked, with what it takes to open them. */}
      {features && !isAdvanced && activeTab !== "overview" && (
        <AdvancedAnalyticsGate note={t("analytics.locked_tab")} />
      )}
    </div>
  );
}

function StatCard({
  title,
  value,
  icon: Icon,
  change,
  changeType,
  hint,
}: {
  title: string;
  value: string;
  icon: any;
  change: string;
  /** "neutral" when there is nothing to compare with. */
  changeType: "positive" | "negative" | "neutral";
  /** What the figure counts, shown as a tooltip. */
  hint?: string;
}) {
  const tone = {
    positive: { icon: "text-green-500", text: "text-green-600" },
    negative: { icon: "text-red-500", text: "text-red-600" },
    neutral: { icon: "text-gray-400", text: "text-gray-500" },
  }[changeType];
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6" title={hint}>
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm font-medium text-gray-500 flex items-center gap-1">
          {title}
          {hint && <Info className="w-3.5 h-3.5 text-gray-400" aria-label={hint} />}
        </span>
        <Icon className={`w-5 h-5 ${tone.icon}`} />
      </div>
      <div className="text-2xl font-bold text-gray-900 mb-2">{value}</div>
      <div className={`text-sm ${tone.text}`}>{change}</div>
    </div>
  );
}

function ProfessionalCard({
  professional,
  rank,
  t,
}: {
  professional: ProfessionalPerformance;
  rank: number;
  t: (key: string, params?: Record<string, any>) => string;
}) {
  const getRankColor = (rank: number) => {
    switch (rank) {
      case 1:
        return "bg-yellow-100 text-yellow-800 border-yellow-300";
      case 2:
        return "bg-gray-100 text-gray-700 border-gray-300";
      case 3:
        return "bg-orange-100 text-orange-800 border-orange-300";
      default:
        return "bg-gray-50 text-gray-600 border-gray-200";
    }
  };

  const getRankIcon = (rank: number) => {
    if (rank === 1) return "🥇";
    if (rank === 2) return "🥈";
    if (rank === 3) return "🥉";
    return `#${rank}`;
  };

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-5 hover:shadow-md transition-shadow">
      <div className="flex items-center space-x-4 mb-4">
        <div className="relative">
          {professional.profileImage ? (
            <img
              src={professional.profileImage}
              alt={professional.name}
              className="w-12 h-12 rounded-full object-cover"
            />
          ) : (
            <div className="w-12 h-12 rounded-full bg-indigo-100 flex items-center justify-center">
              <span className="text-lg font-medium text-indigo-600">
                {professional.firstName?.[0]}
                {professional.lastName?.[0]}
              </span>
            </div>
          )}
          <span
            className={`absolute -top-1 -right-1 w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold border-2 border-white ${getRankColor(rank)}`}
          >
            {getRankIcon(rank)}
          </span>
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-gray-900 truncate">
            {professional.firstName} {professional.lastName}
          </p>
          <p className="text-xs text-gray-500">
            {professional.appointments} {t("analytics.appointments").toLowerCase()}
          </p>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-indigo-50 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold text-indigo-600">
            {professional.appointments}
          </p>
          <p className="text-xs text-indigo-700">
            {t("analytics.appointments")}
          </p>
        </div>
        <div className="bg-green-50 rounded-lg p-3 text-center">
          <p className="text-2xl font-bold text-green-600">
            {formatCents(professional.revenue)}
          </p>
          <p className="text-xs text-green-700">{t("analytics.revenue")}</p>
        </div>
      </div>
    </div>
  );
}

/** The locked Profesionales / Clientas tab: what it holds and the way to Pro. */
function AdvancedAnalyticsGate({ note }: { note: string }) {
  const { plan, inTrial } = useFeatureAccess("advanced_analytics");
  return (
    <div className="bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200 rounded-xl p-8 space-y-4">
      <p className="text-sm text-purple-900 text-center">{note}</p>
      <UpgradeCTA
        feature="advanced_analytics"
        plan={plan}
        inTrial={inTrial}
        href="/dashboard/billing"
      />
    </div>
  );
}

/** A failed section: the reason and a retry, never empty charts that look like data. */
function InlineError({
  message,
  retryLabel,
  onRetry,
}: {
  message: string;
  retryLabel: string;
  onRetry: () => void;
}) {
  return (
    <div
      role="alert"
      className="flex flex-col gap-3 rounded-lg border border-yellow-200 bg-yellow-50 p-4 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex items-center">
        <AlertTriangle className="w-5 h-5 text-yellow-600 mr-3 flex-shrink-0" />
        <p className="text-sm text-yellow-800">{message}</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="self-start rounded-md border border-yellow-300 bg-white px-3 py-1.5 text-sm font-medium text-yellow-800 hover:bg-yellow-100 sm:self-auto"
      >
        {retryLabel}
      </button>
    </div>
  );
}
