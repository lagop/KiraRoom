"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { PLAN_BADGE_CLASSES } from "@kira/shared";
import {
  Building2,
  Plus,
  Search,
  Filter,
  MoreHorizontal,
  Edit,
  Trash2,
  AlertTriangle,
  CheckCircle,
  XCircle,
  ExternalLink,
  Loader2,
} from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";

interface TenantProgress {
  tenantId: string;
  tenantName: string;
  score: number;
  percent: number;
  components: {
    servicesConfigured: boolean;
    workingHoursSet: boolean;
    staffAdded: boolean;
    firstAppointmentCreated: boolean;
  };
  counts: {
    services: number;
    professionals: number;
    appointments: number;
  };
}

interface Tenant {
  id: string;
  name: string;
  slug: string;
  email: string;
  phone: string;
  country: string;
  plan: string;
  subscriptionStatus: string;
  createdAt: string;
  // Set when the tenant has been soft-deleted by a SaaS admin. When
  // present the API list view (without `includeDeleted=true`) hides
  // the row entirely, but the field is typed so future "show deleted"
  // UIs can render a badge without a refactor.
  deletedAt?: string | null;
  userCount: number;
  clientCount: number;
  appointmentCount: number;
  professionalCount: number;
}

/**
 * Renders the per-tenant onboarding progress badge. Score 0..1
 * broken into 4 bands so a SaaS admin can scan a page of 50 tenants
 * and spot the ones that need a nudge.
 */
function ProgressCell({
  value,
  tenantName,
}: {
  value: TenantProgress | "loading" | "error" | undefined;
  tenantName: string;
}) {
  if (!value) {
    return <span className="text-xs text-gray-400">—</span>;
  }
  if (value === "loading") {
    return (
      <span className="inline-flex items-center text-xs text-gray-400">
        <Loader2 className="w-3 h-3 mr-1 animate-spin" />
        …
      </span>
    );
  }
  if (value === "error") {
    return (
      <span
        className="text-xs text-gray-400"
        title={`No se pudo cargar el progreso de ${tenantName}`}
      >
        —
      </span>
    );
  }

  const { percent, components } = value;
  const done = [
    components.servicesConfigured,
    components.workingHoursSet,
    components.staffAdded,
    components.firstAppointmentCreated,
  ].filter(Boolean).length;

  const band =
    percent === 100
      ? { label: "Completo", cls: "bg-emerald-100 text-emerald-800" }
      : percent >= 75
        ? { label: "Casi listo", cls: "bg-amber-100 text-amber-800" }
        : percent >= 50
          ? { label: "En curso", cls: "bg-sky-100 text-sky-800" }
          : { label: "Recién empezado", cls: "bg-slate-100 text-slate-700" };

  return (
    <div className="flex items-center gap-2">
      <span
        className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium ${band.cls}`}
        title={`${done} de 4 pasos completados (servicios, horario, equipo, primera cita)`}
      >
        {band.label}
      </span>
      <span className="text-xs text-gray-500 tabular-nums">{percent}%</span>
    </div>
  );
}

export default function TenantsPage() {
  const t = useTranslations();
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [total, setTotal] = useState(0);
  // SaaS admins can toggle this on to surface soft-deleted tenants in
  // the list (e.g. for recovery). When off, the backend filters them
  // out via `deletedAt: null`. The `deletedAt` field on each row lets
  // the table render a "Deleted" badge so the operator doesn't
  // accidentally try to re-delete a row that's already hidden.
  const [showDeleted, setShowDeleted] = useState(false);

  // Per-tenant onboarding progress score (Sprint 2.1 Workstream 2.1
  // deliverable). Fetched on-demand after the tenant list arrives.
  // The endpoint returns `score (0..1)` + per-component flags; we
  // surface the score as a colored badge so SaaS admins can spot
  // tenants who signed up but never finished onboarding.
  const [progressMap, setProgressMap] = useState<
    Record<string, TenantProgress | "loading" | "error">
  >({});

  const fetchTenants = async () => {
    try {
      setLoading(true);
      const result = await apiClient.getSaasTenants({
        page,
        limit: 10,
        search: search || undefined,
        includeDeleted: showDeleted,
      });
      setTenants(result.data);
      setTotalPages(result.meta.totalPages);
      setTotal(result.meta.total);
    } catch (err) {
      console.error("Error fetching tenants:", err);
      setError(t("saas.failedToLoadTenants"));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchTenants();
  }, [page, search, showDeleted]);

  // Sprint 2.1 — fetch per-tenant progress in parallel after the
  // tenant list arrives. Cheap (one read per row, no auth), and we
  // tolerate failures (show "—" in the cell) so a single bad row
  // doesn't blank out the whole page.
  useEffect(() => {
    if (tenants.length === 0) return;
    let cancelled = false;
    const fetchOne = async (tenantId: string) => {
      setProgressMap((prev) => ({ ...prev, [tenantId]: "loading" }));
      try {
        const p = await apiClient.getTenantProgress(tenantId);
        if (!cancelled) {
          setProgressMap((prev) => ({ ...prev, [tenantId]: p }));
        }
      } catch {
        if (!cancelled) {
          setProgressMap((prev) => ({ ...prev, [tenantId]: "error" }));
        }
      }
    };
    tenants.forEach((t) => {
      // Skip already-cached entries so a page-change doesn't re-fetch
      // the same row.
      if (!progressMap[t.id]) {
        fetchOne(t.id);
      }
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenants]);

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(t("saas.deleteConfirm", { name }))) {
      return;
    }
    try {
      await apiClient.deleteSaasTenant(id);
      fetchTenants();
    } catch (err) {
      console.error("Error deleting tenant:", err);
      alert(t("saas.failedToDelete"));
    }
  };

  const handleSuspend = async (id: string) => {
    try {
      await apiClient.suspendSaasTenant(id);
      fetchTenants();
    } catch (err) {
      console.error("Error suspending tenant:", err);
      alert(t("saas.failedToSuspend"));
    }
  };

  const handleReactivate = async (id: string) => {
    try {
      await apiClient.reactivateSaasTenant(id);
      fetchTenants();
    } catch (err) {
      console.error("Error reactivating tenant:", err);
      alert(t("saas.failedToReactivate"));
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case "active":
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-indigo-100 text-indigo-800">
            <CheckCircle className="w-3 h-3 mr-1" />
            {t("common.active")}
          </span>
        );
      case "trialing":
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800">
            {t("saas.trial")}
          </span>
        );
      case "cancelled":
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800">
            <XCircle className="w-3 h-3 mr-1" />
            {t("appointments.status_cancelled")}
          </span>
        );
      case "past_due":
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-yellow-100 text-yellow-800">
            <AlertTriangle className="w-3 h-3 mr-1" />
            {t("payments.status_pending")}
          </span>
        );
      default:
        return (
          <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
            {status}
          </span>
        );
    }
  };

  const getPlanBadge = (plan: string) => {
    // Plan color map and label lookup come from @kira/shared so the
    // backend's `LEGACY_PLAN_ALIASES` map is the single source of
    // truth. New plan ids land in one place.
    const colorClass =
      PLAN_BADGE_CLASSES[plan as keyof typeof PLAN_BADGE_CLASSES] ??
      "bg-gray-100 text-gray-800";
    return (
      <span
        className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${colorClass}`}
      >
        {t(`saas.plan_${plan}`, { default: plan })}
      </span>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="text-2xl font-bold text-gray-900 truncate">{t("saas.tenants")}</h1>
          <p className="text-gray-500 mt-1">{t("saas.tenants_count", { count: total })}</p>
        </div>
        <Link
          href="/saas/tenants/new"
          className="inline-flex items-center px-4 py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800 transition-colors self-start sm:self-auto"
        >
          <Plus className="w-4 h-4 mr-2" />
          {t("saas.create_tenant")}
        </Link>
      </div>

      {/* Filters */}
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:gap-4">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 text-gray-400 w-4 h-4" />
          <input
            type="text"
            placeholder={t("saas.search_tenants")}
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            className="pl-10 pr-4 py-2 border border-gray-200 rounded-lg w-full focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
          />
        </div>
        <label className="inline-flex items-center text-sm text-gray-700 whitespace-nowrap cursor-pointer">
          <input
            type="checkbox"
            checked={showDeleted}
            onChange={(e) => {
              setShowDeleted(e.target.checked);
              setPage(1);
            }}
            className="mr-2 h-4 w-4 rounded border-gray-300 text-slate-900 focus:ring-slate-500"
          />
          {t("saas.show_deleted")}
        </label>
      </div>

      {/* Table */}
      {loading ? (
        <div className="flex items-center justify-center h-64">
          <div className="animate-spin w-8 h-8 border-4 border-slate-800 border-t-transparent rounded-full"></div>
        </div>
      ) : error ? (
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 text-center">
          <AlertTriangle className="w-8 h-8 text-red-500 mx-auto mb-2" />
          <p className="text-red-600">{error}</p>
        </div>
      ) : (
        <>
          <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                      {t("saas.tenants")}
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                      {t("settings.address")}
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                      {t("saas.plan")}
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                      {t("saas.status")}
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                      Onboarding
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                      {t("saas.users")} / {t("clients.title")}
                    </th>
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase tracking-wider whitespace-nowrap">
                      {t("saas.actions")}
                    </th>
                  </tr>
                </thead>
              <tbody className="bg-white divide-y divide-gray-200">
                {tenants.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-gray-500">
                      {t("saas.no_tenants")}
                    </td>
                  </tr>
                ) : (
                  tenants.map((tenant) => (
                    <tr key={tenant.id} className="hover:bg-gray-50">
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center">
                          <div className="w-10 h-10 bg-slate-100 rounded-lg flex items-center justify-center">
                            <Building2 className="w-5 h-5 text-slate-600" />
                          </div>
                          <div className="ml-4">
                            <div className="text-sm font-medium text-gray-900">
                              {tenant.name}
                            </div>
                            <div className="text-sm text-gray-500">
                              {tenant.email || t("saas.no_email")}
                            </div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="text-sm text-gray-900">{tenant.country}</div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          {getPlanBadge(tenant.plan)}
                          {tenant.deletedAt && (
                            <span
                              className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-800"
                              title={t("saas.deleted_badge_title", {
                                at: new Date(tenant.deletedAt).toLocaleString(),
                              })}
                            >
                              {t("saas.deleted_badge")}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        {getStatusBadge(tenant.subscriptionStatus)}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <ProgressCell
                          value={progressMap[tenant.id]}
                          tenantName={tenant.name}
                        />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {tenant.userCount} / {tenant.clientCount}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                        <div className="flex items-center justify-end space-x-2">
                          {!tenant.deletedAt && (
                            <button
                              onClick={async () => {
                                try {
                                  const res = await apiClient.launchSalonDashboard(tenant.id);
                                  window.location.href = `/login?as_owner=${tenant.id}&token=${encodeURIComponent(res.token)}&owner=${encodeURIComponent(res.ownerName)}`;
                                } catch (err) {
                                  alert(t("saas.failed_to_load") || t("saas.failedToLoadTenant"));
                                }
                              }}
                              className="p-2 text-gray-400 hover:text-indigo-600 rounded-lg hover:bg-indigo-50"
                              title={t("saas.launch")}
                            >
                              <ExternalLink className="w-4 h-4" />
                            </button>
                          )}
                          <Link
                            href={`/saas/tenants/${tenant.id}`}
                            className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
                            title={t("saas.view")}
                          >
                            <Building2 className="w-4 h-4" />
                          </Link>
                          {!tenant.deletedAt && (
                            <Link
                              href={`/saas/tenants/${tenant.id}/edit`}
                              className="p-2 text-gray-400 hover:text-gray-600 rounded-lg hover:bg-gray-100"
                              title={t("common.edit")}
                            >
                              <Edit className="w-4 h-4" />
                            </Link>
                          )}
                          {!tenant.deletedAt &&
                            (tenant.subscriptionStatus === "active" || tenant.subscriptionStatus === "trialing" ? (
                              <button
                                onClick={() => handleSuspend(tenant.id)}
                                className="p-2 text-gray-400 hover:text-yellow-600 rounded-lg hover:bg-yellow-50"
                                title={t("saas.suspend_action")}
                              >
                                <AlertTriangle className="w-4 h-4" />
                              </button>
                            ) : (
                              <button
                                onClick={() => handleReactivate(tenant.id)}
                                className="p-2 text-gray-400 hover:text-indigo-600 rounded-lg hover:bg-indigo-50"
                                title={t("saas.reactivate_action")}
                              >
                                <CheckCircle className="w-4 h-4" />
                              </button>
                            ))}
                          {!tenant.deletedAt && (
                            <button
                              onClick={() => handleDelete(tenant.id, tenant.name)}
                              className="p-2 text-gray-400 hover:text-indigo-600 rounded-lg hover:bg-indigo-50"
                              title={t("saas.delete_action")}
                            >
                              <Trash2 className="w-4 h-4" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
            </div>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <p className="text-sm text-gray-500">
                {t("payments.showing")} {(page - 1) * 10 + 1} {t("payments.to")} {Math.min(page * 10, total)} {t("payments.of")} {total} {t("payments.results")}
              </p>
              <div className="flex items-center space-x-2">
                <button
                  onClick={() => setPage(page - 1)}
                  disabled={page === 1}
                  className="px-3 py-2 border border-gray-200 rounded-lg text-sm font-medium text-gray-600 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                >
                  {t("common.previous")}
                </button>
                <span className="text-sm text-gray-600">
                  {page} / {totalPages}
                </span>
                <button
                  onClick={() => setPage(page + 1)}
                  disabled={page === totalPages}
                  className="px-3 py-2 border border-gray-200 rounded-lg text-sm font-medium text-gray-600 disabled:opacity-50 disabled:cursor-not-allowed hover:bg-gray-50"
                >
                  {t("common.next")}
                </button>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}