"use client";

import { useState, useEffect } from "react";
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
} from "lucide-react";
import apiClient from "../../../lib/api";
import { useTranslations } from "@/lib/use-translation";
import Link from "next/link";
import { PlanGate } from "@/components/billing/PlanGate";
import { UpgradeCTA } from "@/components/billing/UpgradeCTA";
import { useFeatureAccess } from "@/hooks/useFeatureAccess";

interface DashboardStats {
  totalRevenue: number;
  totalAppointments: number;
  newClients: number;
  avgOrderValue: number;
  revenueChange: number;
  appointmentsChange: number;
  clientsChange: number;
  orderValueChange: number;
}

interface RevenueDataPoint {
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
  color: string;
}

interface StatusEvolution {
  period: string;
  Completed: number;
  Confirmed: number;
  Pending: number;
  Cancelled: number;
  "No Show": number;
  "In Progress": number;
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
  returningClients: number;
  totalAppointments: number;
  retentionRate: number;
  period: string;
}

interface AnalyticsFeatureFlags {
  hasAdvancedAnalytics: boolean;
  hasDetailedReports: boolean;
  hasForecasting: boolean;
  hasExport: boolean;
  maxMonths: number;
}

interface AnalyticsData {
  stats: DashboardStats;
  revenueData: RevenueDataPoint[];
  servicePopularity: ServicePopularity[];
  appointmentStatus: AppointmentStatusData[];
  topServices?: { name: string; count: number; revenue: number }[];
  topProfessionals?: ProfessionalPerformance[];
  dailyMetrics?: { date: string; appointments: number; revenue: number }[];
}

type StatusType = "Completed" | "Cancelled" | "No Show";

export default function AnalyticsPage() {
  const t = useTranslations();
  const [loading, setLoading] = useState(true);
  const [data, setData] = useState<AnalyticsData | null>(null);
  const [features, setFeatures] = useState<AnalyticsFeatureFlags | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [timeRange, setTimeRange] = useState<number>(3);
  const [professionalRange, setProfessionalRange] =
    useState<string>("this_month");
  const [activeTab, setActiveTab] = useState<
    "overview" | "professionals" | "clients"
  >("overview");
  const [professionalData, setProfessionalData] = useState<
    ProfessionalPerformance[]
  >([]);
  const [clientInsights, setClientInsights] = useState<ClientInsights | null>(
    null,
  );
  const [statusesEvolution, setStatusesEvolution] = useState<StatusEvolution[]>(
    [],
  );
  const [statusLast7Days, setStatusLast7Days] = useState<
    AppointmentStatusData[]
  >([]);
  const [statusLast14Days, setStatusLast14Days] = useState<
    AppointmentStatusData[]
  >([]);
  const [evolutionLoading, setEvolutionLoading] = useState(false);
  const [selectedStatus, setSelectedStatus] = useState<StatusType>("Completed");

  useEffect(() => {
    loadAnalytics();
    loadFeatures();
  }, [timeRange]);

  const loadFeatures = async () => {
    try {
      const result = await apiClient.getAnalyticsFeatures();
      setFeatures(result);
      if (result.maxMonths < timeRange) {
        setTimeRange(result.maxMonths);
      }
    } catch (err) {
      console.error("Failed to load features:", err);
      setFeatures({
        hasAdvancedAnalytics: false,
        hasDetailedReports: false,
        hasForecasting: false,
        hasExport: false,
        maxMonths: 3,
      });
    }
  };

  const loadStatusesEvolution = async () => {
    try {
      setEvolutionLoading(true);
      const [evolution, last7, last14] = await Promise.all([
        apiClient.getAppointmentStatusesEvolution(12),
        apiClient.getAppointmentStatusByDays(7),
        apiClient.getAppointmentStatusByDays(14),
      ]);
      setStatusesEvolution(evolution);
      setStatusLast7Days(last7);
      setStatusLast14Days(last14);
    } catch (err) {
      console.error("Failed to load statuses evolution:", err);
      setStatusesEvolution([]);
      setStatusLast7Days([]);
      setStatusLast14Days([]);
    } finally {
      setEvolutionLoading(false);
    }
  };

  useEffect(() => {
    loadStatusesEvolution();
  }, []);

  const loadAnalytics = async () => {
    try {
      setLoading(true);
      setError(null);
      const result = await apiClient.getAnalyticsOverview(timeRange);
      setData(result);
    } catch (err: any) {
      console.error("Failed to load analytics:", err);
      if (
        err?.response?.status === 403 &&
        err?.response?.data?.upgradeRequired
      ) {
        setError(t("analytics.upgrade_required_message"));
      } else {
        setError(t("analytics.failed_to_load_data"));
      }
      if (!err?.response?.data?.upgradeRequired) {
        setData(getMockData());
      }
    } finally {
      setLoading(false);
    }
  };

  const loadAdvancedData = async (tab: "professionals" | "clients") => {
    if (!features?.hasAdvancedAnalytics) return;

    try {
      if (tab === "professionals") {
        const result =
          await apiClient.getProfessionalPerformance(professionalRange);
        setProfessionalData(result);
      } else if (tab === "clients") {
        const result = await apiClient.getClientInsights(timeRange);
        setClientInsights(result);
      }
    } catch (err) {
      console.error(`Failed to load ${tab} data:`, err);
    }
  };

  useEffect(() => {
    if (activeTab !== "overview" && features?.hasAdvancedAnalytics) {
      loadAdvancedData(activeTab);
    }
  }, [activeTab, timeRange, professionalRange, features]);

  const getMockData = (): AnalyticsData => ({
    stats: {
      totalRevenue: 0,
      totalAppointments: 0,
      newClients: 0,
      avgOrderValue: 0,
      revenueChange: 0,
      appointmentsChange: 0,
      clientsChange: 0,
      orderValueChange: 0,
    },
    revenueData: [
      { month: "Aug", revenue: 12500 },
      { month: "Sep", revenue: 14200 },
      { month: "Oct", revenue: 15800 },
      { month: "Nov", revenue: 16500 },
      { month: "Dec", revenue: 18200 },
      { month: "Jan", revenue: 21000 },
    ],
    servicePopularity: [
      { name: "Hair Styling", count: 156, percentage: 35 },
      { name: "Massage", count: 98, percentage: 22 },
      { name: "Nail Care", count: 134, percentage: 30 },
      { name: "Facials", count: 58, percentage: 13 },
    ],
    appointmentStatus: [
      { name: "Completed", count: 245, color: "bg-green-500" },
      { name: "Confirmed", count: 89, color: "bg-blue-500" },
      { name: "Pending", count: 34, color: "bg-yellow-500" },
      { name: "Cancelled", count: 18, color: "bg-red-500" },
    ],
  });

  const stats = data?.stats || {
    totalRevenue: 0,
    totalAppointments: 0,
    newClients: 0,
    avgOrderValue: 0,
    revenueChange: 0,
    appointmentsChange: 0,
    clientsChange: 0,
    orderValueChange: 0,
  };

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

  const isAdvanced = features?.hasAdvancedAnalytics;

  // Status colors
  const statusColors: Record<string, string> = {
    Completed: "#22c55e",
    Cancelled: "#ef4444",
    "No Show": "#6b7280",
  };

  const getStatusLabel = (status: string) => {
    switch (status) {
      case "Completed":
        return t("analytics.completed");
      case "Cancelled":
        return t("analytics.cancelled");
      case "No Show":
        return t("analytics.no_show");
      default:
        return status;
    }
  };

  const formatMonthName = (monthValue: string) => {
    // Handle different month formats: "2024-01", "Jan", "January", "January 2024", etc.
    if (monthValue.includes("-")) {
      // Check if it's a full date like "2024-01-15" or just year-month "2024-01"
      const parts = monthValue.split("-");
      if (parts.length >= 2) {
        const monthNum = parseInt(parts[1]);
        if (monthNum >= 1 && monthNum <= 12) {
          const monthKeys = [
            "jan",
            "feb",
            "mar",
            "apr",
            "may",
            "jun",
            "jul",
            "aug",
            "sep",
            "oct",
            "nov",
            "dec",
          ];
          return t(`analytics.months.${monthKeys[monthNum - 1]}`);
        }
      }
    }

    // Handle formats like "January 2024", "Jan 2024", etc.
    const words = monthValue.trim().split(/\s+/);
    if (words.length > 0) {
      const monthPart = words[0].toLowerCase();
      const monthMap: Record<string, string> = {
        january: "jan",
        february: "feb",
        march: "mar",
        april: "apr",
        may: "may",
        june: "jun",
        july: "jul",
        august: "aug",
        september: "sep",
        october: "oct",
        november: "nov",
        december: "dec",
        jan: "jan",
        feb: "feb",
        mar: "mar",
        apr: "apr",
        jun: "jun",
        jul: "jul",
        aug: "aug",
        sep: "sep",
        oct: "oct",
        nov: "nov",
        dec: "dec",
      };

      const monthKey = monthMap[monthPart];
      if (monthKey) {
        return t(`analytics.months.${monthKey}`);
      }
    }

    // Try to extract month from longer strings like "January 2024 data"
    const lowerMonth = monthValue.toLowerCase();
    for (const [fullName, abbr] of Object.entries({
      january: "jan",
      february: "feb",
      march: "mar",
      april: "apr",
      may: "may",
      june: "jun",
      july: "jul",
      august: "aug",
      september: "sep",
      october: "oct",
      november: "nov",
      december: "dec",
    })) {
      if (lowerMonth.includes(fullName)) {
        return t(`analytics.months.${abbr}`);
      }
    }

    // If no mapping found, return original value
    return monthValue;
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 animate-spin text-indigo-600" />
      </div>
    );
  }

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
        </div>
        <div className="flex flex-wrap items-center gap-3">
          {!isAdvanced && (
            <Link
              href="/dashboard/settings?tab=subscription"
              className="flex items-center px-4 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 text-white rounded-lg hover:from-purple-700 hover:to-indigo-700 transition-all"
            >
              <Crown className="w-4 h-4 mr-2" />
              {t("analytics.upgrade_to_pro")}
            </Link>
          )}
          <select
            value={timeRange}
            onChange={(e) => setTimeRange(Number(e.target.value))}
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <option value={3}>{t("analytics.last_3_months")}</option>
            {isAdvanced && (
              <>
                <option value={6}>{t("analytics.last_6_months")}</option>
                <option value={12}>{t("analytics.last_year")}</option>
              </>
            )}
          </select>
        </div>
      </div>

      {error && (
        <div
          className={`rounded-lg p-4 ${error.includes("Upgrade") ? "bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200" : "bg-yellow-50 border border-yellow-200"}`}
        >
          <div className="flex items-center">
            {error.includes("Upgrade") ? (
              <Crown className="w-5 h-5 text-purple-600 mr-3" />
            ) : (
              <Calendar className="w-5 h-5 text-yellow-600 mr-3" />
            )}
            <p
              className={
                error.includes("Upgrade")
                  ? "text-purple-800"
                  : "text-yellow-800"
              }
            >
              {error}
            </p>
          </div>
        </div>
      )}

      {/* Tabs for Advanced Analytics */}
      {isAdvanced && (
        <div className="border-b border-gray-200">
          <nav className="flex space-x-8">
            <button
              onClick={() => setActiveTab("overview")}
              className={`py-4 px-1 border-b-2 font-medium text-sm transition-colors ${
                activeTab === "overview"
                  ? "border-indigo-500 text-indigo-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              {t("analytics.overview")}
            </button>
            <button
              onClick={() => setActiveTab("professionals")}
              className={`py-4 px-1 border-b-2 font-medium text-sm flex items-center transition-colors ${
                activeTab === "professionals"
                  ? "border-indigo-500 text-indigo-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              <Star className="w-4 h-4 mr-1" />
              {t("analytics.professionals")}
            </button>
            <button
              onClick={() => setActiveTab("clients")}
              className={`py-4 px-1 border-b-2 font-medium text-sm flex items-center transition-colors ${
                activeTab === "clients"
                  ? "border-indigo-500 text-indigo-600"
                  : "border-transparent text-gray-500 hover:text-gray-700"
              }`}
            >
              <Users className="w-4 h-4 mr-1" />
              {t("analytics.clients")}
            </button>
          </nav>
        </div>
      )}

      {/* Overview Tab */}
      {activeTab === "overview" && (
        <>
          {/* Stats Grid */}
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <StatCard
              title={t("analytics.total_revenue")}
              value={`€${stats.totalRevenue.toLocaleString()}`}
              icon={DollarSign}
              change={`${stats.revenueChange >= 0 ? "+" : ""}${stats.revenueChange}% ${t("analytics.from_last_month")}`}
              changeType={stats.revenueChange >= 0 ? "positive" : "negative"}
            />
            <StatCard
              title={t("analytics.total_appointments")}
              value={stats.totalAppointments.toString()}
              icon={Calendar}
              change={`${stats.appointmentsChange >= 0 ? "+" : ""}${stats.appointmentsChange}% ${t("analytics.from_last_month")}`}
              changeType={
                stats.appointmentsChange >= 0 ? "positive" : "negative"
              }
            />
            <StatCard
              title={t("analytics.new_clients")}
              value={stats.newClients.toString()}
              icon={Users}
              change={`${stats.clientsChange >= 0 ? "+" : ""}${stats.clientsChange}% ${t("analytics.from_last_month")}`}
              changeType={stats.clientsChange >= 0 ? "positive" : "negative"}
            />
            <StatCard
              title={t("analytics.avg_order_value")}
              value={`€${stats.avgOrderValue.toFixed(2)}`}
              icon={TrendingUp}
              change={`${stats.orderValueChange >= 0 ? "+" : ""}${stats.orderValueChange}% ${t("analytics.from_last_month")}`}
              changeType={stats.orderValueChange >= 0 ? "positive" : "negative"}
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
                {revenueData.map((data, index) => (
                  <div key={index} className="flex items-center">
                    <span className="w-12 text-sm text-gray-600">
                      {formatMonthName(data.month)}
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
                      €{data.revenue.toLocaleString()}
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
                    No service data available
                  </p>
                )}
              </div>
            </div>
          </div>

          {/* Charts Grid - Second Row: Appointment Status Evolution + % Evolution */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Appointment Status Evolution - Half Width */}
            <div className="bg-white rounded-xl border border-gray-200 p-6">
              <div className="flex items-center justify-between mb-6">
                <h2 className="text-lg font-semibold text-gray-900">
                  {t("analytics.appointment_status_evolution")}
                </h2>
                <div className="flex items-center space-x-4 text-xs">
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
              ) : stackedBarData.length > 0 ? (
                <div className="flex items-end justify-between h-48 gap-1">
                  {/* Generate exactly 12 slots for 12 months - stable width */}
                  {Array.from({ length: 12 }).map((_, monthIndex) => {
                    const monthData = stackedBarData[monthIndex];
                    const completedHeight = monthData
                      ? (monthData.Completed / maxStackValue) * 100
                      : 0;
                    const cancelledHeight = monthData
                      ? (monthData.Cancelled / maxStackValue) * 100
                      : 0;
                    const noShowHeight = monthData
                      ? (monthData["No Show"] / maxStackValue) * 100
                      : 0;

                    return (
                      <div
                        key={monthIndex}
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
                              title={
                                monthData
                                  ? `${t("analytics.completed")}: ${monthData.Completed}`
                                  : t("analytics.no_data_available")
                              }
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
                              title={
                                monthData
                                  ? `${t("analytics.cancelled")}: ${monthData.Cancelled}`
                                  : t("analytics.no_data_available")
                              }
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
                              title={
                                monthData
                                  ? `${t("analytics.no_show")}: ${monthData["No Show"]}`
                                  : t("analytics.no_data_available")
                              }
                            />
                          )}
                        </div>
                        <span className="text-xs text-gray-500 mt-2 truncate max-w-full">
                          {monthData ? formatMonthName(monthData.month) : "-"}
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
              {percentageData.length > 0 ? (
                <div className="space-y-3">
                  {percentageData.map((item, index) => (
                    <div key={index} className="flex items-center">
                      <span className="w-12 text-xs text-gray-600">
                        {formatMonthName(item.month)}
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
                        {item.percentage.toFixed(1)}%
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
                              statusColors[status.name] || "#6b7280";

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
                          const color = statusColors[status.name] || "#6b7280";
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
                                {status.name}: {percentage}%
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
                              statusColors[status.name] || "#6b7280";

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
                          const color = statusColors[status.name] || "#6b7280";
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
                                {status.name}: {percentage}%
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
                    {totalAppointments14Days > 0 &&
                    statusLast14Days.find((s) => s.name === "Completed")
                      ? Math.round(
                          (statusLast14Days.find((s) => s.name === "Completed")!
                            .count /
                            totalAppointments14Days) *
                            100,
                        )
                      : 0}
                    %
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
                    {totalAppointments14Days > 0 &&
                    statusLast14Days.find((s) => s.name === "Cancelled")
                      ? Math.round(
                          (statusLast14Days.find((s) => s.name === "Cancelled")!
                            .count /
                            totalAppointments14Days) *
                            100,
                        )
                      : 0}
                    %
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
                    {totalAppointments14Days > 0 &&
                    statusLast14Days.find((s) => s.name === "No Show")
                      ? Math.round(
                          (statusLast14Days.find((s) => s.name === "No Show")!
                            .count /
                            totalAppointments14Days) *
                            100,
                        )
                      : 0}
                    %
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
                    {totalAppointments7Days > 0 &&
                    totalAppointments14Days > 0 ? (
                      totalAppointments7Days >= totalAppointments14Days / 2 ? (
                        <ArrowUpRight className="w-5 h-5 text-green-600 mr-1" />
                      ) : (
                        <ArrowDownRight className="w-5 h-5 text-red-600 mr-1" />
                      )
                    ) : null}
                    <span
                      className={`text-lg font-bold ${totalAppointments7Days >= totalAppointments14Days / 2 ? "text-green-600" : "text-red-600"}`}
                    >
                      {totalAppointments14Days > 0
                        ? Math.round(
                            (totalAppointments7Days /
                              (totalAppointments14Days / 2)) *
                              100 -
                              100,
                          )
                        : 0}
                      %
                    </span>
                  </div>
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
                  <option value="6_months">
                    {t("analytics.last_6_months")}
                  </option>
                </select>
              </div>
            </div>

            {professionalData.length > 0 ? (
              <div className="space-y-6">
                <div className="space-y-4">
                  {professionalData.slice(0, 5).map((professional, index) => (
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
                        €{professional.revenue.toLocaleString()}
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

          {clientInsights ? (
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

              <div className="bg-blue-50 rounded-lg p-6">
                <div className="flex items-center justify-between mb-2">
                  <Star className="w-5 h-5 text-blue-600" />
                  <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full">
                    {t("analytics.returning")}
                  </span>
                </div>
                <p className="text-3xl font-bold text-gray-900">
                  {clientInsights.returningClients}
                </p>
                <p className="text-sm text-gray-600">
                  {t("analytics.returning_clients")}
                </p>
              </div>

              <div className="bg-green-50 rounded-lg p-6">
                <div className="flex items-center justify-between mb-2">
                  <Calendar className="w-5 h-5 text-green-600" />
                </div>
                <p className="text-3xl font-bold text-gray-900">
                  {clientInsights.totalAppointments}
                </p>
                <p className="text-sm text-gray-600">
                  {t("analytics.total_appointments")}
                </p>
              </div>

              <div className="bg-purple-50 rounded-lg p-6">
                <div className="flex items-center justify-between mb-2">
                  <TrendingUp className="w-5 h-5 text-purple-600" />
                </div>
                <p className="text-3xl font-bold text-gray-900">
                  {clientInsights.retentionRate}%
                </p>
                <p className="text-sm text-gray-600">
                  {t("analytics.retention_rate")}
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

      {/* Locked State for Free Users (rev3 unified plan gate) */}
      {!isAdvanced && activeTab !== "overview" && (
        <AdvancedAnalyticsGate />
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
}: {
  title: string;
  value: string;
  icon: any;
  change: string;
  changeType: "positive" | "negative";
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <span className="text-sm font-medium text-gray-500">{title}</span>
        <Icon
          className={`w-5 h-5 ${changeType === "positive" ? "text-green-500" : "text-red-500"}`}
        />
      </div>
      <div className="text-2xl font-bold text-gray-900 mb-2">{value}</div>
      <div
        className={`text-sm ${changeType === "positive" ? "text-green-600" : "text-red-600"}`}
      >
        {change}
      </div>
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
            {professional.appointments} appointment
            {professional.appointments !== 1 ? "s" : ""}
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
            €{professional.revenue.toLocaleString()}
          </p>
          <p className="text-xs text-green-700">{t("analytics.revenue")}</p>
        </div>
      </div>
    </div>
  );
}

function AdvancedAnalyticsGate() {
  const { plan, inTrial } = useFeatureAccess("advanced_analytics");
  return (
    <div className="bg-gradient-to-r from-purple-50 to-indigo-50 border border-purple-200 rounded-xl p-8">
      <UpgradeCTA
        feature="advanced_analytics"
        plan={plan}
        inTrial={inTrial}
        href="/dashboard/billing"
      />
    </div>
  );
}
