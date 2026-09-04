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

interface TenantStats {
  tenantId: string;
  tenantName: string;
  plan: string;
  subscriptionStatus: string;
  totalClients: number;
  totalAppointments: number;
  totalRevenue: number;
  appointmentsThisMonth: number;
  appointmentsLastMonth: number;
  appointmentsChange: number;
  revenueThisMonth: number;
  revenueLastMonth: number;
  revenueChange: number;
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
            Back to Salons
          </Link>
        </div>
      </div>
    );
  }

  const formatCurrency = (cents: number) => {
    return `€${(cents / 100).toFixed(2)}`;
  };

  const statCards = [
    {
      title: "Total Revenue",
      value: formatCurrency(stats.totalRevenue),
      icon: DollarSign,
      change: `${formatCurrency(stats.revenueThisMonth)} this month`,
      changeValue: stats.revenueChange,
      changeLabel: "vs last month",
    },
    {
      title: "Total Appointments",
      value: stats.totalAppointments.toLocaleString(),
      icon: Calendar,
      change: `${stats.appointmentsThisMonth} this month`,
      changeValue: stats.appointmentsChange,
      changeLabel: "vs last month",
    },
    {
      title: "Total Clients",
      value: stats.totalClients.toLocaleString(),
      icon: Users,
      change: t("saas.registeredClients"),
    },
    {
      title: "Subscription Plan",
      value: stats.plan.charAt(0).toUpperCase() + stats.plan.slice(1),
      icon: Building2,
      change: stats.subscriptionStatus,
    },
  ];

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
          <h1 className="text-2xl font-bold text-gray-900 truncate">Analytics</h1>
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
                {stat.changeValue > 0 ? (
                  <TrendingUp className="w-4 h-4 text-indigo-500 mr-1" />
                ) : stat.changeValue < 0 ? (
                  <TrendingDown className="w-4 h-4 text-red-500 mr-1" />
                ) : null}
                <span className={`text-sm ${stat.changeValue > 0 ? "text-indigo-600" : stat.changeValue < 0 ? "text-red-600" : "text-gray-500"}`}>
                  {stat.changeValue > 0 ? "+" : ""}{stat.changeValue}% {stat.changeLabel}
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
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Revenue Comparison</h2>
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-gray-600">This Month</span>
              <span className="font-semibold text-gray-900">{formatCurrency(stats.revenueThisMonth)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">Last Month</span>
              <span className="font-semibold text-gray-900">{formatCurrency(stats.revenueLastMonth)}</span>
            </div>
            <div className="border-t pt-4 flex justify-between items-center">
              <span className="text-gray-600">Change</span>
              <span className={`font-semibold ${stats.revenueChange >= 0 ? "text-indigo-600" : "text-red-600"}`}>
                {stats.revenueChange >= 0 ? "+" : ""}{stats.revenueChange}%
              </span>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Appointments Comparison</h2>
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-gray-600">This Month</span>
              <span className="font-semibold text-gray-900">{stats.appointmentsThisMonth}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">Last Month</span>
              <span className="font-semibold text-gray-900">{stats.appointmentsLastMonth}</span>
            </div>
            <div className="border-t pt-4 flex justify-between items-center">
              <span className="text-gray-600">Change</span>
              <span className={`font-semibold ${stats.appointmentsChange >= 0 ? "text-indigo-600" : "text-red-600"}`}>
                {stats.appointmentsChange >= 0 ? "+" : ""}{stats.appointmentsChange}%
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}