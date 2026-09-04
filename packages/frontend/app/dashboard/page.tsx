"use client";

import {
  AlertCircle,
  Calendar,
  CheckCircle,
  Clock,
  DollarSign,
  Plus,
  TrendingUp,
  UserCheck,
  Users,
} from "lucide-react";
import { useTranslations } from "@/lib/use-translation";
import { DeltaStatCard } from "./components/dashboard/delta-stat-card";
import { CopilotFab } from "./copilot/copilot-fab";
import { PendingConfirmationsWidget } from "./components/dashboard/pending-confirmations-widget";
import { PendingPaymentsWidget } from "./components/dashboard/pending-payments-widget";
import { RevenueSparkline } from "./components/dashboard/revenue-sparkline";
import { StatusDonut } from "./components/dashboard/status-donut";
import { TodayTimeline } from "./components/dashboard/today-timeline";
import { UnreadNotificationsBadge } from "./components/dashboard/unread-notifications-badge";
import { useDashboardData } from "./components/dashboard/use-dashboard-data";

/**
 * The analytics endpoints return monetary values in **cents** (matching
 * the `totalAmount` column on the appointments table). The SaaS
 * dashboard pages divide by 100 before display; we do the same here.
 * Pass `alreadyInMajorUnits: true` for values that are already in
 * major units (e.g. raw `appointment.price`).
 */
const formatMoney = (
  amount: number,
  options: { alreadyInMajorUnits?: boolean } = {},
) => {
  const value = options.alreadyInMajorUnits ? amount : amount / 100;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency: "EUR",
    minimumFractionDigits: value % 1 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(value);
};

const getClientName = (client: any): string => {
  if (!client) return "Unknown client";
  if (typeof client === "string") return client;
  return `${client.firstName ?? ""} ${client.lastName ?? ""}`.trim();
};

const getServiceName = (service: any): string => {
  if (!service) return "—";
  if (typeof service === "string") return service;
  return service.name;
};

const getProfessionalName = (professional: any): string => {
  if (!professional) return "—";
  if (typeof professional === "string") return professional;
  return `${professional.firstName ?? ""} ${professional.lastName ?? ""}`.trim();
};

export default function DashboardPage() {
  const t = useTranslations();
  const { data, loading, error, refresh } = useDashboardData();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin w-12 h-12 border-4 border-purple-500 border-t-transparent rounded-full" />
        <span className="ml-4 text-gray-600">{t("common.loading")}</span>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center max-w-md">
          <AlertCircle className="w-10 h-10 text-red-500 mx-auto mb-2" />
          <h2 className="text-lg font-semibold text-red-800 mb-2">
            {t("dashboard.error_loading")}
          </h2>
          <p className="text-red-600 mb-4">{error}</p>
          <button
            onClick={() => refresh()}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
          >
            {t("dashboard.retry")}
          </button>
        </div>
      </div>
    );
  }

  const totalPending =
    data.pendingConfirmations.length + data.pendingPayments.length;

  return (
    <>
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {t("dashboard.overview")}
          </h1>
          <p className="text-gray-500 mt-1">{t("dashboard.welcome_back")}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <UnreadNotificationsBadge count={data.unreadNotificationsCount} />
          <button
            onClick={() => refresh()}
            className="inline-flex items-center px-3 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
          >
            Refresh
          </button>
        </div>
      </div>

      {/* Action banner when there's pending work */}
      {totalPending > 0 && (
        <div className="bg-gradient-to-r from-amber-50 to-red-50 border border-amber-200 rounded-xl p-4 flex items-center gap-3">
          <div className="p-2 bg-white rounded-lg">
            <AlertCircle className="w-5 h-5 text-amber-600" />
          </div>
          <p className="text-sm text-gray-700">
            You have{" "}
            <span className="font-semibold text-amber-800">
              {data.pendingConfirmations.length}
            </span>{" "}
            appointment{data.pendingConfirmations.length === 1 ? "" : "s"} to
            confirm and{" "}
            <span className="font-semibold text-red-800">
              {data.pendingPayments.length}
            </span>{" "}
            pending payment{data.pendingPayments.length === 1 ? "" : "s"}.
          </p>
        </div>
      )}

      {/* Primary KPI row — replaces free-text changes with real deltas */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <DeltaStatCard
          title="Revenue this month"
          value={formatMoney(data.stats.totalRevenue)}
          icon={DollarSign}
          changePercent={data.stats.revenueChange}
          changeLabel="vs. last month"
          iconClassName="bg-emerald-50 text-emerald-600"
        />
        <DeltaStatCard
          title="Appointments"
          value={data.stats.totalAppointments}
          icon={Calendar}
          changePercent={data.stats.appointmentsChange}
          changeLabel="vs. last month"
          iconClassName="bg-indigo-50 text-indigo-600"
        />
        <DeltaStatCard
          title="New clients"
          value={data.stats.newClients}
          icon={UserCheck}
          changePercent={data.stats.clientsChange}
          changeLabel="vs. last month"
          iconClassName="bg-violet-50 text-violet-600"
        />
        <DeltaStatCard
          title="Avg ticket"
          value={formatMoney(data.stats.avgOrderValue)}
          icon={TrendingUp}
          changePercent={data.stats.orderValueChange}
          changeLabel="vs. last month"
          iconClassName="bg-amber-50 text-amber-600"
        />
      </div>

      {/* Secondary KPI row */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <DeltaStatCard
          title="Today's payments"
          value={formatMoney(data.todayPaymentsTotal)}
          icon={DollarSign}
          changeLabel={`${data.todayPayments.length} transaction${data.todayPayments.length === 1 ? "" : "s"} today`}
          iconClassName="bg-emerald-50 text-emerald-600"
        />
        <DeltaStatCard
          title="Pending confirmations"
          value={data.pendingConfirmations.length}
          icon={Clock}
          changeLabel="awaiting your action"
          iconClassName="bg-amber-50 text-amber-600"
        />
        <DeltaStatCard
          title="Total clients"
          value={data.totalClients}
          icon={Users}
          changeLabel="active in your CRM"
          iconClassName="bg-violet-50 text-violet-600"
        />
        <DeltaStatCard
          title="Active professionals"
          value={data.activeProfessionals}
          icon={Users}
          changeLabel="on schedule"
          iconClassName="bg-sky-50 text-sky-600"
        />
      </div>

      {/* Charts row: revenue sparkline + status breakdown */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h2 className="text-base font-semibold text-gray-900">
                Revenue trend
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                Last {data.dailyMetrics.length} days ·{" "}
                <span className="font-medium text-gray-900">
                  {formatMoney(
                    data.dailyMetrics.reduce(
                      (sum, d) => sum + (d.revenue || 0),
                      0,
                    ),
                  )}
                </span>{" "}
                total
              </p>
            </div>
            <TrendingUp className="w-5 h-5 text-violet-400" />
          </div>
          <RevenueSparkline data={data.dailyMetrics} height={84} />
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-4">
            Status (last 14 days)
          </h2>
          <StatusDonut data={data.statusByDays} />
        </div>
      </div>

      {/* Today's schedule + action widgets */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-6 lg:col-span-1">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900">
                Today's schedule
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {data.upcomingAppointments.length} appointment
                {data.upcomingAppointments.length === 1 ? "" : "s"} left today
              </p>
            </div>
            <Calendar className="w-5 h-5 text-gray-400" />
          </div>
          <TodayTimeline appointments={data.upcomingAppointments} />
        </div>

        <PendingConfirmationsWidget
          appointments={data.pendingConfirmations}
          className="lg:col-span-1"
        />

        <PendingPaymentsWidget
          appointments={data.pendingPayments}
          className="lg:col-span-1"
        />
      </div>

      {/* Upcoming appointments list + Quick actions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">
              Upcoming today
            </h2>
            <a
              href="/dashboard/appointments"
              className="text-sm text-purple-600 hover:text-purple-700"
            >
              {t("dashboard.view_all")}
            </a>
          </div>
          <div className="space-y-4">
            {data.upcomingAppointments.length > 0 ? (
              data.upcomingAppointments.map((appointment) => (
                <div
                  key={appointment.id}
                  className="flex items-center justify-between p-3 bg-gray-50 rounded-lg"
                >
                  <div className="flex items-center space-x-3 min-w-0">
                    <div className="w-10 h-10 bg-indigo-100 rounded-full flex items-center justify-center flex-shrink-0">
                      <Users className="w-5 h-5 text-indigo-600" />
                    </div>
                    <div className="min-w-0">
                      <p className="font-medium text-gray-900 truncate">
                        {getClientName(appointment.client)}
                      </p>
                      <p className="text-sm text-gray-500 truncate">
                        {getServiceName(appointment.service)}
                      </p>
                      <p className="text-xs text-gray-400 truncate">
                        with {getProfessionalName(appointment.professional)}
                      </p>
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0 ml-3">
                    <p className="font-medium text-gray-900">
                      {appointment.scheduledTime}
                    </p>
                    <span
                      className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                        appointment.status === "completed"
                          ? "bg-green-100 text-green-800"
                          : appointment.status === "in_progress"
                            ? "bg-blue-100 text-blue-800"
                            : appointment.status === "confirmed"
                              ? "bg-purple-100 text-purple-800"
                              : "bg-yellow-100 text-yellow-800"
                      }`}
                    >
                      {appointment.status === "completed" && (
                        <CheckCircle className="w-3 h-3 mr-1" />
                      )}
                      {appointment.status === "in_progress" && (
                        <Clock className="w-3 h-3 mr-1" />
                      )}
                      {appointment.status === "pending" && (
                        <AlertCircle className="w-3 h-3 mr-1" />
                      )}
                      {t(`dashboard.status_${appointment.status}`)}
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center py-8 text-gray-500">
                {t("dashboard.no_upcoming_appointments")}
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">
            {t("dashboard.quick_actions")}
          </h2>
          <div className="grid grid-cols-2 gap-4">
            <a
              href="/dashboard/appointments?new=true"
              className="flex flex-col items-center p-4 bg-purple-50 rounded-lg hover:bg-purple-100 transition-colors"
            >
              <Calendar className="w-8 h-8 text-purple-600 mb-2" />
              <span className="font-medium text-purple-900">
                {t("dashboard.new_appointment")}
              </span>
            </a>
            <a
              href="/dashboard/clients?new=true"
              className="flex flex-col items-center p-4 bg-green-50 rounded-lg hover:bg-green-100 transition-colors"
            >
              <Users className="w-8 h-8 text-green-600 mb-2" />
              <span className="font-medium text-green-900">
                {t("dashboard.add_client")}
              </span>
            </a>
            <a
              href="/dashboard/professionals?new=true"
              className="flex flex-col items-center p-4 bg-violet-50 rounded-lg hover:bg-violet-100 transition-colors"
            >
              <UserCheck className="w-8 h-8 text-violet-600 mb-2" />
              <span className="font-medium text-violet-900">
                {t("dashboard.add_professional")}
              </span>
            </a>
            <a
              href="/dashboard/services?new=true"
              className="flex flex-col items-center p-4 bg-amber-50 rounded-lg hover:bg-amber-100 transition-colors"
            >
              <Plus className="w-8 h-8 text-amber-600 mb-2" />
              <span className="font-medium text-amber-900">
                {t("dashboard.add_service")}
              </span>
            </a>
          </div>
        </div>
      </div>
     </div>
     <CopilotFab />
    </>
   );
}
