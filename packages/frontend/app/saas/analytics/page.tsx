"use client";

import { useState, useEffect } from "react";
import { TrendingUp, Users, Building2, DollarSign, Calendar } from "lucide-react";
import apiClient from "@/lib/api";
import { LineChart } from "../components/line-chart";
import { MetricCard } from "../components/metric-card";
import { useTranslations } from "@/lib/use-translation";
import { countryName, formatEuros, formatPercent } from "@/lib/console-metrics";

/** GET /saas/analytics/overview. Amounts in euros. */
interface Analytics {
  totalTenants: number;
  totalUsers: number;
  totalClients: number;
  totalAppointments: number;
  salonTakingsTotal: number;
  mrr: number;
  arr: number;
  payingTenants: number;
  activeWithoutBilling: number;
  avgMrrPerPayingSalon: number;
  trialTenants: number;
  pastDueTenants: number;
  suspendedTenants: number;
  cancelledTenants: number;
  newTenantsThisMonth: number;
  newUsersThisMonth: number;
  topCountries: { country: string; count: number }[];
  planDistribution: { plan: string; count: number }[];
}

/** GET /saas/analytics/growth. Madrid calendar months; null = no base to compare with. */
interface GrowthMetrics {
  period: string;
  salonsEvolution: { month: string; total: number; new: number }[];
  salonTakingsEvolution: { month: string; value: number }[];
  usersEvolution: { month: string; total: number; new: number }[];
  appointmentsEvolution: { month: string; value: number }[];
  summary: {
    salonTakingsThisMonth: number;
    salonTakingsLastMonth: number;
    salonTakingsChangePercent: number | null;
    newSalonsThisMonth: number;
    newSalonsLastMonth: number;
    newSalonsChangePercent: number | null;
    newUsersThisMonth: number;
    newUsersLastMonth: number;
    newUsersChangePercent: number | null;
    paidCancellationsThisMonth: number;
    paidCancellationsLastMonth: number;
    expiredTrialsThisMonth: number;
    expiredTrialsLastMonth: number;
    paidChurnRate: number | null;
    trialConversionRateThisMonth: number | null;
    trialConversionRateLastMonth: number | null;
  };
  lifecycleEvolution: {
    month: string;
    trialsEnded: number;
    trialsConverted: number;
  }[];
}

export default function SaasAnalyticsPage() {
  const t = useTranslations();
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [growth, setGrowth] = useState<GrowthMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const [analyticsData, growthData] = await Promise.all([
          apiClient.getSaasAnalytics(),
          apiClient.getPlatformGrowthMetrics(6),
        ]);
        setAnalytics(analyticsData);
        setGrowth(growthData);
      } catch (err) {
        console.error("Error fetching analytics:", err);
        setError(t("saas.failedToLoadAnalytics"));
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin w-12 h-12 border-4 border-slate-800 border-t-transparent rounded-full"></div>
      </div>
    );
  }

  if (error || !analytics) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="text-red-600">{error || t("saas.failedToLoadAnalytics")}</div>
      </div>
    );
  }

  const planLabel = (plan: string) => {
    const key = `saas.plan_${plan}`;
    const label = t(key);
    return label === key ? plan : label;
  };

  const summary = growth?.summary;
  const currentLifecycle = growth?.lifecycleEvolution[growth.lifecycleEvolution.length - 1];

  // Each arrow compares the same figure with the previous Madrid month;
  // none is shown where there is no previous month to compare with.
  const stats = [
    {
      title: t("saas.metrics.new_salons_month"),
      value: summary?.newSalonsThisMonth ?? analytics.newTenantsThisMonth,
      icon: Building2,
      change: summary?.newSalonsChangePercent ?? null,
      changeLabel: t("saas.metrics.vs_last_month"),
      subtitle: `${t("saas.metrics.total_salons")}: ${analytics.totalTenants}`,
    },
    {
      title: t("saas.metrics.new_users_month"),
      value: summary?.newUsersThisMonth ?? analytics.newUsersThisMonth,
      icon: Users,
      change: summary?.newUsersChangePercent ?? null,
      changeLabel: t("saas.metrics.vs_last_month"),
      subtitle: `${t("saas.metrics.total_users")}: ${analytics.totalUsers}`,
    },
    {
      title: t("saas.metrics.mrr_title"),
      value: formatEuros(analytics.mrr),
      icon: DollarSign,
      change: undefined,
      changeLabel: undefined,
      subtitle: t("saas.metrics.mrr_hint", { arr: formatEuros(analytics.arr) }),
    },
    {
      title: t("saas.metrics.total_appointments"),
      value: analytics.totalAppointments,
      icon: Calendar,
      change: undefined,
      changeLabel: undefined,
      subtitle: t("saas.metrics.all_time"),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 truncate">{t("saas.metrics.analytics_title")}</h1>
          <p className="text-gray-500 mt-1">{t("saas.metrics.analytics_subtitle")}</p>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        {stats.map((stat) => (
          <MetricCard
            key={stat.title}
            title={stat.title}
            value={stat.value}
            icon={<stat.icon className="w-5 h-5" />}
            change={stat.change}
            changeLabel={stat.changeLabel}
            subtitle={stat.subtitle}
          />
        ))}
      </div>

      {/* Cancellations and trial conversion, this month (audit 8 D4) */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t("saas.metrics.churn_title")}</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <div>
            <p className="text-sm text-gray-500">{t("saas.metrics.paid_cancellations")}</p>
            <p className="text-2xl font-bold text-red-600">{summary?.paidCancellationsThisMonth ?? 0}</p>
            <p className="text-xs text-gray-400">
              {t("saas.metrics.last_month_value", { value: summary?.paidCancellationsLastMonth ?? 0 })}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-500">{t("saas.metrics.paid_churn_rate")}</p>
            <p className="text-2xl font-bold text-red-600">{formatPercent(summary?.paidChurnRate)}</p>
            <p className="text-xs text-gray-400">{t("saas.metrics.paid_churn_hint")}</p>
          </div>
          <div>
            <p className="text-sm text-gray-500">{t("saas.metrics.expired_trials")}</p>
            <p className="text-2xl font-bold text-gray-900">{summary?.expiredTrialsThisMonth ?? 0}</p>
            <p className="text-xs text-gray-400">
              {t("saas.metrics.last_month_value", { value: summary?.expiredTrialsLastMonth ?? 0 })}
            </p>
          </div>
          <div>
            <p className="text-sm text-gray-500">{t("saas.metrics.trial_conversion")}</p>
            <p className="text-2xl font-bold text-indigo-600">
              {formatPercent(summary?.trialConversionRateThisMonth)}
            </p>
            <p className="text-xs text-gray-400">
              {t("saas.metrics.trial_conversion_hint", {
                converted: currentLifecycle?.trialsConverted ?? 0,
                ended: currentLifecycle?.trialsEnded ?? 0,
              })}
              {" · "}
              {t("saas.metrics.last_month_value", {
                value: formatPercent(summary?.trialConversionRateLastMonth),
              })}
            </p>
          </div>
        </div>
      </div>

      {/* Evolution Charts */}
      {growth && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 gap-4 sm:gap-6">
          <LineChart
            data={growth.salonsEvolution.map((d) => ({ month: d.month, value: d.total }))}
            title={t("saas.metrics.salons_evolution")}
            color="#6366f1"
          />
          <LineChart
            data={growth.usersEvolution.map((d) => ({ month: d.month, value: d.total }))}
            title={t("saas.metrics.users_evolution")}
            color="#4f46e5"
          />
          <LineChart
            data={growth.appointmentsEvolution.map((d) => ({ month: d.month, value: d.value }))}
            title={t("saas.metrics.appointments_evolution")}
            color="#4338ca"
          />
          {/* Salons' takings, in euros: what they charged their clients. */}
          <LineChart
            data={growth.salonTakingsEvolution.map((d) => ({ month: d.month, value: d.value }))}
            title={t("saas.metrics.takings_evolution")}
            valueSuffix=" €"
            color="#64748b"
          />
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
        {/* KiraRoom revenue, then the salons' takings apart */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">{t("saas.metrics.kiraroom_revenue")}</h2>
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-gray-600">MRR</span>
              <span className="font-semibold text-gray-900">{formatEuros(analytics.mrr)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">{t("saas.metrics.arr")}</span>
              <span className="font-semibold text-gray-900">{formatEuros(analytics.arr)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">{t("saas.metrics.avg_per_paying")}</span>
              <span className="font-semibold text-gray-900">{formatEuros(analytics.avgMrrPerPayingSalon)}</span>
            </div>
            {analytics.activeWithoutBilling > 0 && (
              <div className="flex justify-between items-center gap-3">
                <span className="text-gray-600 text-sm">{t("saas.metrics.active_without_billing")}</span>
                <span className="font-semibold text-amber-600">{analytics.activeWithoutBilling}</span>
              </div>
            )}
            <div className="pt-4 border-t">
              <div className="flex justify-between items-center gap-3">
                <span className="text-gray-600">{t("saas.metrics.salon_takings_title")}</span>
                <span className="font-semibold text-gray-900">{formatEuros(analytics.salonTakingsTotal)}</span>
              </div>
              <p className="text-xs text-gray-400 mt-1">
                {t("saas.metrics.salon_takings_total")}. {t("saas.metrics.salon_takings_note")}
              </p>
            </div>
          </div>
        </div>

        {/* Salon status and plans */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">{t("saas.metrics.status_title")}</h2>
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-gray-600">{t("saas.metrics.status_paying")}</span>
              <span className="font-semibold text-indigo-600">{analytics.payingTenants}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">{t("saas.metrics.status_trialing")}</span>
              <span className="font-semibold text-blue-600">{analytics.trialTenants}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">{t("saas.metrics.status_past_due")}</span>
              <span className="font-semibold text-amber-600">{analytics.pastDueTenants}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">{t("saas.metrics.status_suspended")}</span>
              <span className="font-semibold text-red-600">{analytics.suspendedTenants}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">{t("saas.metrics.status_cancelled")}</span>
              <span className="font-semibold text-gray-900">{analytics.cancelledTenants}</span>
            </div>
            <div className="border-t pt-4 space-y-3">
              <p className="text-sm font-semibold text-gray-700">{t("saas.subscription_plans")}</p>
              {analytics.planDistribution.length === 0 ? (
                <p className="text-sm text-gray-400">{t("saas.metrics.no_salons")}</p>
              ) : (
                analytics.planDistribution.map((plan) => (
                  <div key={plan.plan} className="flex justify-between items-center">
                    <span className="text-gray-600">{planLabel(plan.plan)}</span>
                    <span className="font-semibold text-gray-900">{plan.count}</span>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>

        {/* Top Countries */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">{t("saas.metrics.countries_title")}</h2>
          <div className="space-y-3">
            {analytics.topCountries.length === 0 ? (
              <p className="text-sm text-gray-400">{t("saas.metrics.no_salons")}</p>
            ) : (
              analytics.topCountries.map((country) => (
                <div key={country.country} className="flex justify-between items-center">
                  <span className="text-gray-600">{countryName(country.country)}</span>
                  <span className="font-semibold text-gray-900">
                    {t("saas.metrics.salons_count", { n: country.count })}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>

        {/* Clients */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4 flex items-center gap-2">
            <TrendingUp className="w-5 h-5 text-gray-400" />
            {t("saas.metrics.clients_title")}
          </h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-gray-600">{t("saas.metrics.total_clients")}</span>
              <span className="font-semibold text-gray-900">{analytics.totalClients.toLocaleString("es-ES")}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-600">{t("saas.metrics.avg_clients")}</span>
              <span className="font-semibold text-gray-900">
                {analytics.totalTenants ? Math.round(analytics.totalClients / analytics.totalTenants) : 0}
              </span>
            </div>
          </div>
          <p className="text-xs text-gray-400 mt-4">{t("saas.metrics.excluded_note")}</p>
        </div>
      </div>
    </div>
  );
}
