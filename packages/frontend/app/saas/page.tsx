"use client";

import { useState, useEffect } from "react";
import {
  Building2,
  Users,
  DollarSign,
  TrendingUp,
  Building,
  AlertCircle,
  CheckCircle,
  Key,
} from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { countryName, formatEuros } from "@/lib/console-metrics";
import Link from "next/link";
import WeeklySummary from "./components/weekly-summary";

/** GET /saas/analytics/overview (backend saas-analytics.service.ts). Amounts in euros. */
interface SaasAnalytics {
  totalTenants: number;
  totalUsers: number;
  totalClients: number;
  totalAppointments: number;
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

export default function SaasOverviewPage() {
  const t = useTranslations();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [analytics, setAnalytics] = useState<SaasAnalytics | null>(null);

  useEffect(() => {
    const fetchAnalytics = async () => {
      try {
        setLoading(true);
        const data = await apiClient.getSaasAnalytics();
        setAnalytics(data);
      } catch (err) {
        console.error("Error fetching analytics:", err);
        setError(t("saas.loadError"));
      } finally {
        setLoading(false);
      }
    };

    fetchAnalytics();
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin w-12 h-12 border-4 border-slate-800 border-t-transparent rounded-full"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <AlertCircle className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <h2 className="text-lg font-semibold text-red-800 mb-2">
            {t("common.error")}
          </h2>
          <p className="text-red-600 mb-4">{error}</p>
          <button
            onClick={() => window.location.reload()}
            className="px-4 py-2 bg-red-600 text-white rounded-lg hover:bg-red-700 transition-colors"
          >
            {t("dashboard.retry")}
          </button>
        </div>
      </div>
    );
  }

  const planLabel = (plan: string) => {
    const key = `saas.plan_${plan}`;
    const label = t(key);
    return label === key ? plan : label;
  };

  const stats = [
    {
      title: t("saas.metrics.total_salons"),
      value: analytics?.totalTenants || 0,
      icon: Building2,
      change: t("saas.metrics.new_this_month", { n: analytics?.newTenantsThisMonth || 0 }),
      changeType: "positive" as const,
      href: "/saas/tenants",
    },
    {
      title: t("saas.metrics.total_users"),
      value: analytics?.totalUsers || 0,
      icon: Users,
      change: t("saas.metrics.new_this_month", { n: analytics?.newUsersThisMonth || 0 }),
      changeType: "positive" as const,
      href: "/saas/users",
    },
    {
      // KiraRoom's own revenue: the paying salons' plans and add-ons.
      title: t("saas.metrics.mrr_title"),
      value: formatEuros(analytics?.mrr),
      icon: DollarSign,
      change: t("saas.metrics.mrr_hint", { arr: formatEuros(analytics?.arr) }),
      changeType: "neutral" as const,
      href: "/saas/analytics",
    },
    {
      title: t("saas.metrics.paying_salons"),
      value: analytics?.payingTenants || 0,
      icon: CheckCircle,
      change: t("saas.metrics.paying_hint", {
        trial: analytics?.trialTenants || 0,
        pastDue: analytics?.pastDueTenants || 0,
      }),
      changeType: "neutral" as const,
      href: "/saas/tenants",
    },
  ];

  const statusRows = [
    { label: t("saas.metrics.status_paying"), value: analytics?.payingTenants || 0, tone: "text-indigo-600" },
    { label: t("saas.metrics.status_trialing"), value: analytics?.trialTenants || 0, tone: "text-blue-600" },
    { label: t("saas.metrics.status_past_due"), value: analytics?.pastDueTenants || 0, tone: "text-amber-600" },
    { label: t("saas.metrics.status_suspended"), value: analytics?.suspendedTenants || 0, tone: "text-red-600" },
    { label: t("saas.metrics.status_cancelled"), value: analytics?.cancelledTenants || 0, tone: "text-gray-900" },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 truncate">{t("saas.platform_analytics")}</h1>
          <p className="text-gray-500 mt-1">
            {t("saas.subtitle")}
          </p>
        </div>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 sm:gap-6">
        {stats.map((stat) => (
          <Link
            key={stat.title}
            href={stat.href || "#"}
            className="bg-white rounded-xl border border-gray-200 p-6 hover:shadow-lg transition-shadow"
          >
            <div className="flex items-center justify-between mb-4">
              <div className="p-3 bg-slate-100 rounded-lg">
                <stat.icon className="w-6 h-6 text-slate-800" />
              </div>
              <span
                className={`text-sm text-right ${
                  stat.changeType === "positive"
                    ? "text-indigo-600"
                    : "text-gray-500"
                }`}
              >
                {stat.change}
              </span>
            </div>
            <h3 className="text-2xl font-bold text-gray-900">{stat.value}</h3>
            <p className="text-gray-500 text-sm">{stat.title}</p>
          </Link>
        ))}
      </div>

      {/* What needs looking at this week (audit 8 D12) */}
      <WeeklySummary />

      {/* Secondary Stats. The salons' takings are shown per salon only
          (tenant detail and its analytics), never here (audit 8 D10). */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            {t("saas.metrics.kiraroom_revenue")}
          </h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-gray-600">MRR</span>
              <span className="font-semibold text-gray-900">{formatEuros(analytics?.mrr)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">{t("saas.metrics.arr")}</span>
              <span className="font-semibold text-gray-900">{formatEuros(analytics?.arr)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">{t("saas.metrics.avg_per_paying")}</span>
              <span className="font-semibold text-gray-900">{formatEuros(analytics?.avgMrrPerPayingSalon)}</span>
            </div>
            {(analytics?.activeWithoutBilling || 0) > 0 && (
              <div className="flex justify-between items-center gap-3">
                <span className="text-gray-600 text-sm">{t("saas.metrics.active_without_billing")}</span>
                <span className="font-semibold text-amber-600">{analytics?.activeWithoutBilling}</span>
              </div>
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            {t("saas.metrics.status_title")}
          </h3>
          <div className="space-y-3">
            {statusRows.map((row) => (
              <div key={row.label} className="flex justify-between items-center">
                <span className="text-gray-600">{row.label}</span>
                <span className={`font-semibold ${row.tone}`}>{row.value}</span>
              </div>
            ))}
          </div>
          <h4 className="text-sm font-semibold text-gray-700 mt-5 mb-2">
            {t("saas.subscription_plans")}
          </h4>
          <div className="space-y-2">
            {(analytics?.planDistribution ?? []).length === 0 ? (
              <p className="text-sm text-gray-400">{t("saas.metrics.no_salons")}</p>
            ) : (
              analytics?.planDistribution.map((plan) => (
                <div key={plan.plan} className="flex justify-between items-center">
                  <span className="text-gray-600">{planLabel(plan.plan)}</span>
                  <span className="font-semibold text-gray-900">{plan.count}</span>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            {t("saas.metrics.countries_title")}
          </h3>
          <div className="space-y-3">
            {(analytics?.topCountries ?? []).length === 0 ? (
              <p className="text-sm text-gray-400">{t("saas.metrics.no_salons")}</p>
            ) : (
              analytics?.topCountries.map((country) => (
                <div key={country.country} className="flex justify-between items-center">
                  <span className="text-gray-600">{countryName(country.country)}</span>
                  <span className="font-semibold text-gray-900">{country.count}</span>
                </div>
              ))
            )}
          </div>
          <p className="text-xs text-gray-400 mt-4">{t("saas.metrics.excluded_note")}</p>
        </div>
      </div>

      {/* Quick Actions */}
      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h3 className="text-lg font-semibold text-gray-900 mb-4">{t("dashboard.quick_actions")}</h3>
        <div className="grid grid-cols-2 sm:grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
          <Link
            href="/saas/tenants/new"
            className="flex flex-col items-center p-4 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
          >
            <Building className="w-8 h-8 text-slate-800 mb-2" />
            <span className="font-medium text-slate-900">{t("saas.add_salon")}</span>
          </Link>
          <Link
            href="/saas/tenants"
            className="flex flex-col items-center p-4 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
          >
            <Building2 className="w-8 h-8 text-slate-800 mb-2" />
            <span className="font-medium text-slate-900">{t("saas.view_salons")}</span>
          </Link>
          <Link
            href="/saas/users"
            className="flex flex-col items-center p-4 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
          >
            <Users className="w-8 h-8 text-slate-800 mb-2" />
            <span className="font-medium text-slate-900">{t("saas.manage_users")}</span>
          </Link>
          <Link
            href="/saas/analytics"
            className="flex flex-col items-center p-4 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
          >
            <TrendingUp className="w-8 h-8 text-slate-800 mb-2" />
            <span className="font-medium text-slate-900">{t("saas.analytics")}</span>
          </Link>
          <Link
            href="/saas/settings/platform-llm"
            className="flex flex-col items-center p-4 bg-slate-100 rounded-lg hover:bg-slate-200 transition-colors"
          >
            <Key className="w-8 h-8 text-slate-800 mb-2" />
            <span className="font-medium text-slate-900 text-center leading-tight">
              Proveedor de IA
              <br />
              <span className="text-xs text-gray-500 font-normal">Haiku · Sonnet</span>
            </span>
          </Link>
        </div>
      </div>
    </div>
  );
}