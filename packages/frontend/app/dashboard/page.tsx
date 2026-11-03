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
import { formatCents } from "@/lib/analytics-format";
import { countKey, personName, remainingToday, statusLabelKey } from "@/lib/home-dashboard";
import { DeltaStatCard } from "./components/dashboard/delta-stat-card";
import { CopilotFab } from "./copilot/copilot-fab";
import { PendingConfirmationsWidget } from "./components/dashboard/pending-confirmations-widget";
import { PendingPaymentsWidget } from "./components/dashboard/pending-payments-widget";
import { RevenueSparkline } from "./components/dashboard/revenue-sparkline";
import { StatusDonut } from "./components/dashboard/status-donut";
import { TodayTimeline } from "./components/dashboard/today-timeline";
import { UnreadNotificationsBadge } from "./components/dashboard/unread-notifications-badge";
import { useDashboardData } from "./components/dashboard/use-dashboard-data";
import { IssuerDataBanner } from "@/components/invoices/issuer-data-banner";

/** Rows of "Quedan hoy". */
const UPCOMING_ROWS = 5;

const STATUS_PILL: Record<string, string> = {
  in_progress: "bg-blue-100 text-blue-800",
  confirmed: "bg-purple-100 text-purple-800",
  pending: "bg-yellow-100 text-yellow-800",
};

export default function DashboardPage() {
  const t = useTranslations();
  const { data, loading, error, partialFailures, salonFigures, refresh } = useDashboardData();

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin w-12 h-12 border-4 border-purple-500 border-t-transparent rounded-full" />
        <span className="ml-4 text-gray-600">{t("common.loading")}</span>
      </div>
    );
  }

  if (error !== null) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center max-w-md">
          <AlertCircle className="w-10 h-10 text-red-500 mx-auto mb-2" />
          <h2 className="text-lg font-semibold text-red-800 mb-2">
            {t("dashboard.error_loading")}
          </h2>
          <p className="text-red-600 mb-4">{error || t("dashboard.loadError")}</p>
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

  // A professional's figures are their own (the API scopes them): the cards say so.
  const own = !salonFigures;
  const toConfirm = data.pendingConfirmations.total;
  const toCharge = data.pendingPayments.total;
  const pendingParts = [
    toConfirm > 0 ? t(countKey("dashboard.banner_to_confirm", toConfirm), { count: toConfirm }) : null,
    toCharge > 0 ? t(countKey("dashboard.banner_to_charge", toCharge), { count: toCharge }) : null,
  ].filter((p): p is string => p !== null);

  // What is left of today, by the salon's clock.
  const upcoming = remainingToday(data.todayAppointments, data.now);
  const sameDaysLastMonth = t("dashboard.vs_same_days_last_month");
  const noPrevious = t("analytics.no_previous_data");
  const hint = (title: string, text: string) => ({
    label: t("analytics.what_counts", { metric: title }),
    text,
  });
  const revenueTitle = t("dashboard.appointment_revenue_month");
  const paymentsTitle = own ? t("dashboard.my_today_payments") : t("dashboard.today_payments");

  return (
    <>
      {partialFailures.length > 0 && (
        <div className="mb-4 flex items-center justify-between gap-4 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-800">
          <span className="flex items-center gap-2">
            <AlertCircle className="h-5 w-5 shrink-0" />
            {t("dashboard.partial_load_warning")}
          </span>
          <button
            onClick={() => refresh()}
            className="shrink-0 rounded-lg bg-amber-600 px-3 py-1.5 text-sm text-white hover:bg-amber-700"
          >
            {t("dashboard.retry")}
          </button>
        </div>
      )}
    <div className="space-y-6">
      {/* No NIF, razón social or address for the invoices: owner and admins only. */}
      <IssuerDataBanner />
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
            {t("dashboard.refresh")}
          </button>
        </div>
      </div>

      {/* Action banner when there's pending work (the true totals, not the five shown) */}
      {pendingParts.length > 0 && (
        <div className="bg-gradient-to-r from-amber-50 to-red-50 border border-amber-200 rounded-xl p-4 flex items-center gap-3">
          <div className="p-2 bg-white rounded-lg">
            <AlertCircle className="w-5 h-5 text-amber-600" />
          </div>
          <p className="text-sm text-gray-700">
            {pendingParts.length === 2
              ? t("dashboard.pending_banner", { confirmations: pendingParts[0], payments: pendingParts[1] })
              : t("dashboard.pending_banner_single", { item: pendingParts[0] })}
          </p>
        </div>
      )}

      {/* Primary KPI row (owner and admins): Analítica's figures, its names and its help texts */}
      {salonFigures && (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-6">
        <DeltaStatCard
          title={revenueTitle}
          value={formatCents(data.stats.totalRevenue)}
          icon={DollarSign}
          hint={hint(revenueTitle, t("analytics.revenue_hint"))}
          changePercent={data.stats.revenueChange}
          changeLabel={sameDaysLastMonth}
          noDeltaLabel={noPrevious}
          iconClassName="bg-emerald-50 text-emerald-600"
        />
        <DeltaStatCard
          title={t("analytics.total_appointments")}
          value={data.stats.totalAppointments}
          icon={Calendar}
          hint={hint(t("analytics.total_appointments"), t("analytics.appointments_hint"))}
          changePercent={data.stats.appointmentsChange}
          changeLabel={sameDaysLastMonth}
          noDeltaLabel={noPrevious}
          iconClassName="bg-indigo-50 text-indigo-600"
        />
        <DeltaStatCard
          title={t("analytics.new_clients")}
          value={data.stats.newClients}
          icon={UserCheck}
          hint={hint(t("analytics.new_clients"), t("analytics.new_clients_hint"))}
          changePercent={data.stats.clientsChange}
          changeLabel={sameDaysLastMonth}
          noDeltaLabel={noPrevious}
          iconClassName="bg-violet-50 text-violet-600"
        />
        <DeltaStatCard
          title={t("analytics.avg_order_value")}
          value={formatCents(data.stats.avgOrderValue)}
          icon={TrendingUp}
          hint={hint(t("analytics.avg_order_value"), t("analytics.avg_ticket_hint"))}
          changePercent={data.stats.orderValueChange}
          changeLabel={sameDaysLastMonth}
          noDeltaLabel={noPrevious}
          iconClassName="bg-amber-50 text-amber-600"
        />
      </div>
      )}

      {/* Secondary KPI row */}
      <div className={`grid grid-cols-1 md:grid-cols-2 gap-6 ${salonFigures ? "lg:grid-cols-4" : "lg:grid-cols-3"}`}>
        <DeltaStatCard
          title={paymentsTitle}
          value={formatCents(data.todayPaymentsTotal)}
          icon={DollarSign}
          hint={hint(paymentsTitle, t("dashboard.today_payments_hint"))}
          changeLabel={t(countKey("dashboard.payments_count", data.todayPaymentsCount), {
            count: data.todayPaymentsCount,
          })}
          iconClassName="bg-emerald-50 text-emerald-600"
        />
        <DeltaStatCard
          title={t("dashboard.to_confirm_title")}
          value={toConfirm}
          icon={Clock}
          changeLabel={t("dashboard.to_confirm_sub")}
          iconClassName="bg-amber-50 text-amber-600"
        />
        <DeltaStatCard
          title={own ? t("dashboard.my_clients") : t("dashboard.active_clients")}
          value={data.totalClients}
          icon={Users}
          changeLabel={own ? t("dashboard.my_clients_sub") : t("dashboard.active_clients_sub")}
          iconClassName="bg-violet-50 text-violet-600"
        />
        {/* The team is the managers' to list (staff are answered 403). */}
        {salonFigures && (
          <DeltaStatCard
            title={t("dashboard.active_professionals")}
            value={data.activeProfessionals}
            icon={Users}
            changeLabel={t("dashboard.active_professionals_sub")}
            iconClassName="bg-sky-50 text-sky-600"
          />
        )}
      </div>

      {/* Charts row: revenue sparkline + status breakdown (owner and admins) */}
      {salonFigures && (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-6 lg:col-span-2">
          <div className="flex items-center justify-between mb-2">
            <div>
              <h2 className="text-base font-semibold text-gray-900">
                {t("dashboard.revenue_trend")}
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {t("dashboard.revenue_trend_sub", {
                  days: data.dailyMetrics.length,
                  total: formatCents(data.dailyMetrics.reduce((sum, d) => sum + (d.revenue || 0), 0)),
                })}
              </p>
            </div>
            <TrendingUp className="w-5 h-5 text-violet-400" />
          </div>
          <RevenueSparkline data={data.dailyMetrics} height={84} />
        </div>
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-base font-semibold text-gray-900 mb-4">
            {t("dashboard.status_last_14_days")}
          </h2>
          <StatusDonut data={data.statusByDays} />
        </div>
      </div>
      )}

      {/* Today's schedule + action widgets */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-6 lg:col-span-1">
          <div className="flex items-center justify-between mb-4">
            <div>
              <h2 className="text-base font-semibold text-gray-900">
                {t("dashboard.todays_schedule")}
              </h2>
              <p className="text-xs text-gray-500 mt-0.5">
                {upcoming.length === 0
                  ? t("dashboard.left_today_zero")
                  : t(countKey("dashboard.left_today", upcoming.length), { count: upcoming.length })}
              </p>
            </div>
            <Calendar className="w-5 h-5 text-gray-400" />
          </div>
          <TodayTimeline appointments={data.todayAppointments} now={data.now} />
        </div>

        <PendingConfirmationsWidget
          appointments={data.pendingConfirmations.items}
          total={toConfirm}
          className="lg:col-span-1"
        />

        <PendingPaymentsWidget
          appointments={data.pendingPayments.items}
          total={toCharge}
          totalDue={data.pendingPayments.totalDue}
          className="lg:col-span-1"
        />
      </div>

      {/* Upcoming appointments list + Quick actions */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-lg font-semibold text-gray-900">
              {t("dashboard.upcoming_today")}
            </h2>
            <a
              href="/dashboard/appointments"
              className="text-sm text-purple-600 hover:text-purple-700"
            >
              {t("dashboard.view_all")}
            </a>
          </div>
          <div className="space-y-4">
            {upcoming.length > 0 ? (
              upcoming.slice(0, UPCOMING_ROWS).map((appointment) => (
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
                        {personName(appointment.client) || t("dashboard.unknown_client")}
                      </p>
                      <p className="text-sm text-gray-500 truncate">
                        {appointment.service?.name ?? "—"}
                      </p>
                      {appointment.professional && (
                        <p className="text-xs text-gray-400 truncate">
                          {t("dashboard.with_professional", { name: personName(appointment.professional) })}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0 ml-3">
                    <p className="font-medium text-gray-900">
                      {appointment.scheduledTime}
                    </p>
                    <span
                      className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                        STATUS_PILL[appointment.status] ?? "bg-gray-100 text-gray-800"
                      }`}
                    >
                      {appointment.status === "confirmed" && (
                        <CheckCircle className="w-3 h-3 mr-1" />
                      )}
                      {appointment.status === "in_progress" && (
                        <Clock className="w-3 h-3 mr-1" />
                      )}
                      {appointment.status === "pending" && (
                        <AlertCircle className="w-3 h-3 mr-1" />
                      )}
                      {t(statusLabelKey(appointment.status))}
                    </span>
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center py-8 text-gray-500">
                {t("dashboard.left_today_zero")}
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
            {/* The team and the catalogue are the managers' (staff are answered 403). */}
            {salonFigures && (
              <a
                href="/dashboard/professionals?new=true"
                className="flex flex-col items-center p-4 bg-violet-50 rounded-lg hover:bg-violet-100 transition-colors"
              >
                <UserCheck className="w-8 h-8 text-violet-600 mb-2" />
                <span className="font-medium text-violet-900">
                  {t("dashboard.add_professional")}
                </span>
              </a>
            )}
            {salonFigures && (
              <a
                href="/dashboard/services?new=true"
                className="flex flex-col items-center p-4 bg-amber-50 rounded-lg hover:bg-amber-100 transition-colors"
              >
                <Plus className="w-8 h-8 text-amber-600 mb-2" />
                <span className="font-medium text-amber-900">
                  {t("dashboard.add_service")}
                </span>
              </a>
            )}
          </div>
        </div>
      </div>
     </div>
     <CopilotFab />
    </>
   );
}
