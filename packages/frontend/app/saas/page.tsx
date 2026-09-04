"use client";

import { useState, useEffect } from "react";
import {
  Building2,
  Users,
  DollarSign,
  TrendingUp,
  UserPlus,
  Building,
  AlertCircle,
  CheckCircle,
  Key,
} from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import Link from "next/link";

interface SaasAnalytics {
  totalTenants: number;
  totalUsers: number;
  totalClients: number;
  totalAppointments: number;
  totalRevenue: number;
  mrr: number;
  newTenantsThisMonth: number;
  newUsersThisMonth: number;
  activeSubscriptions: number;
  trialTenants: number;
  churnedTenants: number;
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

  const stats = [
    {
      title: t("saas.total_tenants"),
      value: analytics?.totalTenants || 0,
      icon: Building2,
      change: `+${analytics?.newTenantsThisMonth || 0} ${t("dashboard.new_this_month")}`,
      changeType: "positive" as const,
      href: "/saas/tenants",
    },
    {
      title: t("saas.total_users"),
      value: analytics?.totalUsers || 0,
      icon: Users,
      change: `+${analytics?.newUsersThisMonth || 0} ${t("dashboard.new_this_month")}`,
      changeType: "positive" as const,
      href: "/saas/users",
    },
    {
      title: t("saas.platform_revenue"),
      value: `€${((analytics?.mrr || 0) / 100).toFixed(2)}`,
      icon: DollarSign,
      change: "MRR",
      changeType: "positive" as const,
    },
    {
      title: t("saas.active_tenants"),
      value: analytics?.activeSubscriptions || 0,
      icon: CheckCircle,
      change: `${analytics?.trialTenants || 0} ${t("saas.trial")}`,
      changeType: "neutral" as const,
    },
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
                className={`text-sm ${
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

      {/* Secondary Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            {t("saas.revenue_breakdown")}
          </h3>
          <div className="space-y-3">
            <div className="flex justify-between items-center">
              <span className="text-gray-600">{t("saas.total_revenue")}</span>
              <span className="font-semibold text-gray-900">
                €{((analytics?.totalRevenue || 0) / 100).toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">MRR</span>
              <span className="font-semibold text-gray-900">
                €{((analytics?.mrr || 0) / 100).toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">{t("saas.avg_per_salon")}</span>
              <span className="font-semibold text-gray-900">
                €
                {analytics?.totalTenants
                  ? ((analytics.mrr / 100) / analytics.totalTenants).toFixed(2)
                  : "0.00"}
              </span>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            {t("saas.subscription_plans")}
          </h3>
          <div className="space-y-3">
            {analytics?.planDistribution.map((plan) => (
              <div key={plan.plan} className="flex justify-between items-center">
                <span className="text-gray-600 capitalize">{plan.plan}</span>
                <span className="font-semibold text-gray-900">{plan.count}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h3 className="text-lg font-semibold text-gray-900 mb-4">
            {t("saas.top_countries")}
          </h3>
          <div className="space-y-3">
            {analytics?.topCountries.map((country) => (
              <div key={country.country} className="flex justify-between items-center">
                <span className="text-gray-600">{country.country}</span>
                <span className="font-semibold text-gray-900">{country.count}</span>
              </div>
            ))}
          </div>
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