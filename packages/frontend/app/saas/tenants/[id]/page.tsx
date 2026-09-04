"use client";

import { useState, useEffect } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Building2,
  Edit,
  AlertTriangle,
  CheckCircle,
  Users,
  Calendar,
  DollarSign,
  TrendingUp,
} from "lucide-react";
import apiClient from "@/lib/api";
import { LineChart } from "../../components/line-chart";
import { useTranslations } from "@/lib/use-translation";
import { GrowthIndicator } from "../../components/metric-card";

interface Tenant {
  id: string;
  name: string;
  slug: string;
  description: string;
  logo: string;
  website: string;
  email: string;
  phone: string;
  whatsapp: string;
  country: string;
  timezone: string;
  currency: string;
  language: string;
  plan: string;
  subscriptionStatus: string;
  createdAt: string;
  userCount: number;
  clientCount: number;
  appointmentCount: number;
  professionalCount: number;
  serviceCount: number;
}

interface TenantStats {
  tenantId: string;
  tenantName: string;
  plan: string;
  subscriptionStatus: string;
  totalClients: number;
  totalAppointments: number;
  totalRevenue: number;
  appointmentsThisMonth: number;
  appointmentsChange: number;
  revenueThisMonth: number;
  revenueLastMonth: number;
  revenueChange: number;
}

interface GrowthMetrics {
  salonId: string;
  period: string;
  revenueEvolution: { month: string; value: number }[];
  appointmentsEvolution: { month: string; value: number }[];
  clientsEvolution: { month: string; value: number; newClients: number; returningClients: number }[];
  summary: {
    revenueThisMonth: number;
    revenueLastMonth: number;
    revenueChangePercent: number;
    appointmentsThisMonth: number;
    appointmentsLastMonth: number;
    appointmentsChangePercent: number;
    newClientsThisMonth: number;
    newClientsLastMonth: number;
    newClientsChangePercent: number;
  };
}

export default function TenantDetailPage() {
  const t = useTranslations();
  const params = useParams();
  const tenantId = (params?.id as string) ?? "";
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [stats, setStats] = useState<TenantStats | null>(null);
  const [growth, setGrowth] = useState<GrowthMetrics | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const [tenantData, statsData, growthData] = await Promise.all([
          apiClient.getSaasTenant(tenantId),
          apiClient.getSaasTenantStats(tenantId),
          apiClient.getSalonGrowthMetrics(tenantId, 6),
        ]);
        setTenant(tenantData);
        setStats(statsData);
        setGrowth(growthData);
      } catch (err) {
        console.error("Error fetching tenant:", err);
        setError(t("saas.failedToLoadTenant"));
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [tenantId]);

  const handleSuspend = async () => {
    if (!confirm(t("saas.suspendConfirm"))) return;
    try {
      await apiClient.suspendSaasTenant(tenantId);
      window.location.reload();
    } catch (err) {
      console.error("Error suspending tenant:", err);
      alert(t("saas.failedToSuspend"));
    }
  };

  const handleReactivate = async () => {
    try {
      await apiClient.reactivateSaasTenant(tenantId);
      window.location.reload();
    } catch (err) {
      console.error("Error reactivating tenant:", err);
      alert(t("saas.failedToReactivate"));
    }
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin w-12 h-12 border-4 border-slate-800 border-t-transparent rounded-full"></div>
      </div>
    );
  }

  if (error || !tenant) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <AlertTriangle className="w-12 h-12 text-red-500 mx-auto mb-4" />
          <p className="text-red-600">{error || t("saas.tenantNotFound")}</p>
          <Link href="/saas/tenants" className="text-blue-600 hover:underline mt-4 inline-block">
            Back to Salons
          </Link>
        </div>
      </div>
    );
  }

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "active":
        return (
          <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-indigo-100 text-indigo-800">
            <CheckCircle className="w-4 h-4 mr-1" />
            Active
          </span>
        );
      case "trialing":
        return (
          <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-blue-100 text-blue-800">
            Trial
          </span>
        );
      case "cancelled":
        return (
          <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-red-100 text-red-800">
            <AlertTriangle className="w-4 h-4 mr-1" />
            Suspended
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-gray-100 text-gray-800">
            {status}
          </span>
        );
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:space-x-4 min-w-0">
          <Link
            href="/saas/tenants"
            className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors self-start sm:self-auto"
          >
            <ArrowLeft className="w-5 h-5" />
          </Link>
          <div className="flex items-center space-x-4 min-w-0">
            <div className="w-12 h-12 bg-slate-100 rounded-lg flex items-center justify-center flex-shrink-0">
              <Building2 className="w-6 h-6 text-slate-600" />
            </div>
            <div className="min-w-0">
              <h1 className="text-2xl font-bold text-gray-900 truncate">{tenant.name}</h1>
              <p className="text-gray-500 truncate">/{tenant.slug}</p>
            </div>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 sm:gap-3">
          {getStatusBadge(tenant.subscriptionStatus)}
          <Link
            href={`/saas/tenants/${tenant.id}/edit`}
            className="inline-flex items-center px-4 py-2 border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
          >
            <Edit className="w-4 h-4 mr-2" />
            Edit
          </Link>
          {tenant.subscriptionStatus === "active" || tenant.subscriptionStatus === "trialing" ? (
            <button
              onClick={handleSuspend}
              className="inline-flex items-center px-4 py-2 border border-yellow-200 rounded-lg text-yellow-700 hover:bg-yellow-50 transition-colors"
            >
              <AlertTriangle className="w-4 h-4 mr-2" />
              Suspend
            </button>
          ) : (
            <button
              onClick={handleReactivate}
              className="inline-flex items-center px-4 py-2 border border-indigo-200 rounded-lg text-indigo-700 hover:bg-indigo-50 transition-colors"
            >
              <CheckCircle className="w-4 h-4 mr-2" />
              Reactivate
            </button>
          )}
        </div>
      </div>

      {/* Stats with Growth */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="p-2 bg-slate-100 rounded-lg">
              <Users className="w-5 h-5 text-slate-700" />
            </div>
            {growth && (
              <GrowthIndicator value={growth.summary.newClientsChangePercent} />
            )}
          </div>
          <h3 className="text-2xl font-bold text-gray-900">{stats?.totalClients || 0}</h3>
          <p className="text-gray-500 text-sm">Total Clients</p>
          {growth && (
            <p className="text-gray-400 text-xs mt-1">
              +{growth.summary.newClientsThisMonth} new this month
            </p>
          )}
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="p-2 bg-slate-100 rounded-lg">
              <Calendar className="w-5 h-5 text-slate-700" />
            </div>
            {stats && (
              <GrowthIndicator value={stats.appointmentsChange} />
            )}
          </div>
          <h3 className="text-2xl font-bold text-gray-900">{stats?.totalAppointments || 0}</h3>
          <p className="text-gray-500 text-sm">Total Appointments</p>
          <p className="text-gray-400 text-xs mt-1">
            {stats?.appointmentsThisMonth || 0} this month
          </p>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="p-2 bg-slate-100 rounded-lg">
              <DollarSign className="w-5 h-5 text-slate-700" />
            </div>
            {stats && (
              <GrowthIndicator value={stats.revenueChange} />
            )}
          </div>
          <h3 className="text-2xl font-bold text-gray-900">
            €{((stats?.totalRevenue || 0) / 100).toFixed(2)}
          </h3>
          <p className="text-gray-500 text-sm">Total Revenue</p>
          <p className="text-gray-400 text-xs mt-1">
            €{((stats?.revenueThisMonth || 0) / 100).toFixed(2)} this month
          </p>
        </div>
      </div>

      {/* Growth Evolution Charts */}
      {growth && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
          <LineChart
            data={growth.revenueEvolution.map((d) => ({
              month: d.month,
              value: d.value / 100,
            }))}
            title={t("saas.revenueEvolution")}
            valuePrefix="€"
            color="#4f46e5"
          />
          <LineChart
            data={growth.appointmentsEvolution.map((d) => ({
              month: d.month,
              value: d.value,
            }))}
            title={t("saas.appointmentsEvolution")}
            color="#6366f1"
          />
        </div>
      )}

      {/* Details */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Salon Details</h2>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-gray-500">Description</dt>
              <dd className="text-gray-900 text-right">{tenant.description || "-"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Email</dt>
              <dd className="text-gray-900">{tenant.email || "-"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Phone</dt>
              <dd className="text-gray-900">{tenant.phone || "-"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Website</dt>
              <dd className="text-gray-900">{tenant.website || "-"}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Country</dt>
              <dd className="text-gray-900">{tenant.country}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Timezone</dt>
              <dd className="text-gray-900">{tenant.timezone}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Currency</dt>
              <dd className="text-gray-900">{tenant.currency}</dd>
            </div>
          </dl>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">Counts</h2>
          <dl className="space-y-3">
            <div className="flex justify-between">
              <dt className="text-gray-500">Users</dt>
              <dd className="text-gray-900">{tenant.userCount}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Clients</dt>
              <dd className="text-gray-900">{tenant.clientCount}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Professionals</dt>
              <dd className="text-gray-900">{tenant.professionalCount}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Services</dt>
              <dd className="text-gray-900">{tenant.serviceCount || 0}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Appointments</dt>
              <dd className="text-gray-900">{tenant.appointmentCount}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Plan</dt>
              <dd className="text-gray-900 capitalize">{tenant.plan}</dd>
            </div>
            <div className="flex justify-between">
              <dt className="text-gray-500">Created</dt>
              <dd className="text-gray-900">{new Date(tenant.createdAt).toLocaleDateString()}</dd>
            </div>
          </dl>
        </div>
      </div>

      {/* Analytics Link */}
      <Link
        href={`/saas/tenants/${tenant.id}/analytics`}
        className="inline-flex items-center px-4 py-2 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-colors"
      >
        <TrendingUp className="w-4 h-4 mr-2" />
        View Full Analytics
      </Link>
    </div>
  );
}