"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Building2,
  Users,
  Calendar,
  DollarSign,
  TrendingUp,
  TrendingDown,
} from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { formatChange, formatEuros } from "@/lib/console-metrics";
import { tenantStatusKey } from "@/lib/saas-tenant";

interface TenantStats {
  tenantId: string;
  tenantName: string;
  plan: string;
  subscriptionStatus: string;
  totalClients: number;
  totalAppointments: number;
  /** Euros: the salon's takings from paid appointments. */
  salonTakingsTotal: number;
  appointmentsThisMonth: number;
  appointmentsLastMonth: number;
  appointmentsChange: number | null;
  salonTakingsThisMonth: number;
  salonTakingsLastMonth: number;
  salonTakingsChange: number | null;
}

export default function TenantAnalyticsPage() {
  const t = useTranslations();
  const params = useParams();
  const tenantId = (params?.id as string) ?? "";
  const [stats, setStats] = useState<TenantStats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchStats = async () => {
      try {
        setLoading(true);
        const data = await apiClient.getSaasTenantStats(tenantId);
        setStats(data);
      } catch (err) {
        console.error("Error fetching tenant stats:", err);
        setError(t("saas.failedToLoadAnalytics"));
      } finally {
        setLoading(false);
      }
    };

    fetchStats();
  }, [tenantId]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin w-12 h-12 border-4 border-slate-800 border-t-transparent rounded-full"></div>
      </div>
    );
  }

  if (error || !stats) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <p className="text-red-600">{error || t("saas.statsNotFound")}</p>
          <Link href="/saas/tenants" className="text-indigo-600 hover:underline mt-4 inline-block">
            {t("saas.metrics.back_to_salons")}
          </Link>
        </div>
      </div>
    );
  }

  const label = (key: string, fallback: string) => {
    const value = t(key);
    return value === key ? fallback : value;
  };

  // Amounts are euros already (Appointment.price): the salon's takings,
  // not KiraRoom's revenue (audit 8 T8).
  const statCards: {
    title: string;
    value: string;
    icon: typeof DollarSign;
    change: string;
    changeValue?: number | null;
  }[] = [
    {
      title: t("saas.metrics.salon_takings"),
      value: formatEuros(stats.salonTakingsTotal),
      icon: DollarSign,
      change: t("saas.metrics.salon_takings_month", { amount: formatEuros(stats.salonTakingsThisMonth) }),
      changeValue: stats.salonTakingsChange,
    },
    {
      title: t("saas.metrics.appointments"),
      value: stats.totalAppointments.toLocaleString("es-ES"),
      icon: Calendar,
      change: t("saas.metrics.appointments_month", { n: stats.appointmentsThisMonth }),
      changeValue: stats.appointmentsChange,
    },
    {
      title: t("saas.metrics.total_clients"),
      value: stats.totalClients.toLocaleString("es-ES"),
      icon: Users,
      change: t("saas.registeredClients"),
    },
    {
      title: t("saas.metrics.plan"),
      value: label(`saas.plan_${stats.plan}`, stats.plan),
      icon: Building2,
      change: label(tenantStatusKey(stats.subscriptionStatus) ?? "", stats.subscriptionStatus),
    },
  ];

  const changeClass = (v: number | null | undefined) =>
    v === null || v === undefined || v === 0 ? "text-gray-500" : v > 0 ? "text-indigo-600" : "text-red-600";

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:space-x-4">
        <Link
          href={`/saas/tenants/${tenantId}`}
          className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors self-start sm:self-auto"
        >
          <ArrowLeft className="w-5 h-5" />
        </Link>
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 truncate">{t("saas.metrics.tenant_analytics_title")}</h1>
          <p className="text-gray-500 truncate">{stats.tenantName}</p>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        {statCards.map((stat) => (
          <div key={stat.title} className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="p-2 bg-slate-100 rounded-lg">
                <stat.icon className="w-5 h-5 text-slate-700" />
              </div>
            </div>
            <h3 className="text-2xl font-bold text-gray-900">{stat.value}</h3>
            <p className="text-gray-500 text-sm">{stat.title}</p>
            {stat.changeValue !== undefined && (
              <div className="flex items-center mt-2">
                {stat.changeValue !== null && stat.changeValue > 0 ? (
                  <TrendingUp className="w-4 h-4 text-indigo-500 mr-1" />
                ) : stat.changeValue !== null && stat.changeValue < 0 ? (
                  <TrendingDown className="w-4 h-4 text-red-500 mr-1" />
                ) : null}
                <span className={`text-sm ${changeClass(stat.changeValue)}`}>
                  {formatChange(stat.changeValue)} {t("saas.metrics.vs_last_month")}
                </span>
              </div>
            )}
            <p className="text-gray-400 text-xs mt-1">{stat.change}</p>
          </div>
        ))}
      </div>

      {/* Monthly Comparison */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">{t("saas.metrics.takings_comparison")}</h2>
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-gray-600">{t("saas.metrics.this_month")}</span>
              <span className="font-semibold text-gray-900">{formatEuros(stats.salonTakingsThisMonth)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">{t("saas.metrics.last_month")}</span>
              <span className="font-semibold text-gray-900">{formatEuros(stats.salonTakingsLastMonth)}</span>
            </div>
            <div className="border-t pt-4 flex justify-between items-center">
              <span className="text-gray-600">{t("saas.metrics.change")}</span>
              <span className={`font-semibold ${changeClass(stats.salonTakingsChange)}`}>
                {formatChange(stats.salonTakingsChange)}
              </span>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-4">{t("saas.metrics.salon_takings_note")}</p>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">{t("saas.metrics.appointments_comparison")}</h2>
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-gray-600">{t("saas.metrics.this_month")}</span>
              <span className="font-semibold text-gray-900">{stats.appointmentsThisMonth}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">{t("saas.metrics.last_month")}</span>
              <span className="font-semibold text-gray-900">{stats.appointmentsLastMonth}</span>
            </div>
            <div className="border-t pt-4 flex justify-between items-center">
              <span className="text-gray-600">{t("saas.metrics.change")}</span>
              <span className={`font-semibold ${changeClass(stats.appointmentsChange)}`}>
                {formatChange(stats.appointmentsChange)}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
