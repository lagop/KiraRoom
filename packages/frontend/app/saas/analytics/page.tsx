"use client";

import { useState, useEffect } from "react";
import {
  BarChart2,
  TrendingUp,
  Users,
  Building2,
  DollarSign,
  Calendar,
} from "lucide-react";
import apiClient from "@/lib/api";
import { LineChart } from "../components/line-chart";
import { MetricCard, GrowthIndicator } from "../components/metric-card";
import { useTranslations } from "@/lib/use-translation";

interface Analytics {
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

interface GrowthMetrics {
  period: string;
  salonsEvolution: { month: string; total: number; new: number }[];
  revenueEvolution: { month: string; value: number }[];
  usersEvolution: { month: string; total: number; new: number }[];
  appointmentsEvolution: { month: string; value: number }[];
  summary: {
    totalRevenueThisMonth: number;
    totalRevenueLastMonth: number;
    revenueChangePercent: number;
    totalNewSalonsThisMonth: number;
    totalNewSalonsLastMonth: number;
    salonsGrowthPercent: number;
    churnRate: number;
  };
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

  const stats = [
    {
      title: "Total Salons",
      value: analytics.totalTenants,
      icon: Building2,
      change: analytics.newTenantsThisMonth > 0
        ? ((analytics.newTenantsThisMonth / analytics.totalTenants) * 100)
        : 0,
      changeLabel: "vs last month",
    },
    {
      title: "Total Users",
      value: analytics.totalUsers,
      icon: Users,
      change: growth?.summary.totalNewSalonsThisMonth
        ? ((growth.summary.totalNewSalonsThisMonth / analytics.totalUsers) * 100)
        : 0,
      changeLabel: "vs last month",
    },
    {
      title: "Monthly Recurring Revenue",
      value: `€${(analytics.mrr / 100).toFixed(2)}`,
      icon: DollarSign,
      change: growth?.summary.revenueChangePercent || 0,
      changeLabel: "vs last month",
    },
    {
      title: "Total Appointments",
      value: analytics.totalAppointments,
      icon: Calendar,
      change: 0,
      changeLabel: "all time",
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900 truncate">Platform Analytics</h1>
          <p className="text-gray-500 mt-1">Monitor platform performance and growth</p>
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
          />
        ))}
      </div>

      {/* Evolution Charts */}
      {growth && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-2 gap-4 sm:gap-6">
          <LineChart
            data={growth.revenueEvolution.map((d) => ({
              month: d.month,
              value: d.value / 100,
            }))}
            title={t("saas.revenueEvolution")}
            valuePrefix="€"
            color="#6366f1"
          />
          <LineChart
            data={growth.usersEvolution.map((d) => ({
              month: d.month,
              value: d.total,
            }))}
            title={t("saas.usersGrowth")}
            color="#4f46e5"
          />
          <LineChart
            data={growth.appointmentsEvolution.map((d) => ({
              month: d.month,
              value: d.value,
            }))}
            title={t("saas.appointmentsEvolution")}
            color="#4338ca"
          />
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
        {/* Revenue Overview */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Revenue Overview</h2>
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <span className="text-gray-600">Total Revenue (All Time)</span>
              <span className="font-semibold text-gray-900">
                €{((analytics.totalRevenue || 0) / 100).toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">Monthly Recurring</span>
              <span className="font-semibold text-gray-900">
                €{(analytics.mrr / 100).toFixed(2)}
              </span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">Avg Revenue per Salon</span>
              <span className="font-semibold text-gray-900">
                €
                {analytics.totalTenants
                  ? ((analytics.mrr / 100) / analytics.totalTenants).toFixed(2)
                  : "0.00"}
              </span>
            </div>
            {growth && (
              <div className="flex justify-between items-center pt-2 border-t">
                <span className="text-gray-600">This Month vs Last</span>
                <GrowthIndicator
                  value={growth.summary.revenueChangePercent}
                  label="revenue"
                />
              </div>
            )}
          </div>
        </div>

        {/* Subscription Distribution */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Subscription Plans</h2>
          <div className="space-y-4">
            {analytics.planDistribution.map((plan) => (
              <div key={plan.plan} className="flex justify-between items-center">
                <span className="text-gray-600 capitalize">{plan.plan}</span>
                <span className="font-semibold text-gray-900">{plan.count}</span>
              </div>
            ))}
            <div className="border-t pt-4 flex justify-between items-center">
              <span className="text-gray-600">Active</span>
              <span className="font-semibold text-indigo-600">{analytics.activeSubscriptions}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">On Trial</span>
              <span className="font-semibold text-blue-600">{analytics.trialTenants}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-gray-600">Churned</span>
              <span className="font-semibold text-red-600">{analytics.churnedTenants}</span>
            </div>
          </div>
        </div>

        {/* Top Countries */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Top Countries</h2>
          <div className="space-y-3">
            {analytics.topCountries.map((country) => (
              <div key={country.country} className="flex justify-between items-center">
                <span className="text-gray-600">{country.country}</span>
                <span className="font-semibold text-gray-900">{country.count} salons</span>
              </div>
            ))}
          </div>
        </div>

        {/* Growth Metrics */}
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Growth Metrics</h2>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-gray-600">New Salons (This Month)</span>
              <div className="flex items-center space-x-2">
                <span className="font-semibold text-indigo-600">+{analytics.newTenantsThisMonth}</span>
                {growth && (
                  <GrowthIndicator
                    value={growth.summary.salonsGrowthPercent}
                    label="MoM"
                  />
                )}
              </div>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-600">New Users (This Month)</span>
              <span className="font-semibold text-indigo-600">+{analytics.newUsersThisMonth}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-600">Churn Rate</span>
              <span className="font-semibold text-red-600">
                {analytics.totalTenants
                  ? ((analytics.churnedTenants / analytics.totalTenants) * 100).toFixed(1)
                  : "0"}%
              </span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-600">Total Clients</span>
              <span className="font-semibold text-gray-900">{analytics.totalClients}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-gray-600">Avg Clients per Salon</span>
              <span className="font-semibold text-gray-900">
                {analytics.totalTenants
                  ? Math.round(analytics.totalClients / analytics.totalTenants)
                  : 0}
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}