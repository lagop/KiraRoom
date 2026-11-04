"use client";

import { useState, useEffect, useCallback } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import {
  ArrowLeft,
  Building2,
  Edit,
  AlertTriangle,
  CheckCircle,
  XCircle,
  Users,
  Calendar,
  DollarSign,
  TrendingUp,
  Download,
  ShieldAlert,
} from "lucide-react";
import apiClient, { type SaasGdprRequest } from "@/lib/api";
import { LineChart } from "../../components/line-chart";
import { useTranslations } from "@/lib/use-translation";
import { formatEuros } from "@/lib/console-metrics";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";
import { GrowthIndicator } from "../../components/metric-card";
import { SharedIdentityNotice } from "../../components/shared-identity-notice";
import type { SharedIdentityWarning } from "@/lib/shared-identity";
import { saveBlob } from "@/lib/share-download";
import type { TenantAction } from "@/lib/saas-tenant";
import { TenantStatusButtons, TenantStatusDialog, TenantStatusExtraBadges } from "../../components/tenant-status-actions";
import {
  anonymizeNeedsForce,
  formatDateEs,
  sameSalonName,
  tenantStatusClass,
  tenantStatusKey,
} from "@/lib/saas-tenant";

interface Tenant {
  id: string;
  name: string;
  slug: string;
  description: string | null;
  logo: string | null;
  website: string | null;
  email: string | null;
  phone: string | null;
  whatsapp: string | null;
  country: string;
  timezone: string;
  currency: string;
  language: string;
  plan: string;
  subscriptionStatus: string;
  trialEnd: string | null;
  currentPeriodEnd: string | null;
  hasStripeSubscription: boolean;
  createdAt: string;
  deletedAt: string | null;
  anonymizedAt: string | null;
  deletionRequestedAt: string | null;
  /** Blocked from the console (D4) and the courtesy period (D6). */
  blockedAt: string | null;
  blockedReason: string | null;
  courtesyUntil: string | null;
  courtesyPlan: string | null;
  owner: { id: string; email: string; firstName: string | null; lastName: string | null; phone: string | null } | null;
  retention: {
    readOnlyUntil: string | null;
    anonymizeOn: string | null;
    warnedAt: string | null;
    nextStep: "warn" | "anonymize" | null;
  };
  userCount: number;
  clientCount: number;
  appointmentCount: number;
  professionalCount: number;
  serviceCount: number;
  /** Other salons with the same phone or NIF (D9). */
  sharedIdentity?: SharedIdentityWarning[];
}

interface TenantStats {
  totalClients: number;
  totalAppointments: number;
  /** Euros the salon charged for paid appointments: its takings, not KiraRoom's. */
  salonTakingsTotal: number;
  appointmentsThisMonth: number;
  appointmentsChange: number | null;
  salonTakingsThisMonth: number;
  salonTakingsLastMonth: number;
  salonTakingsChange: number | null;
}

interface GrowthMetrics {
  salonId: string;
  period: string;
  salonTakingsEvolution: { month: string; value: number }[];
  appointmentsEvolution: { month: string; value: number }[];
  summary: {
    salonTakingsThisMonth: number;
    salonTakingsLastMonth: number;
    salonTakingsChangePercent: number | null;
    appointmentsThisMonth: number;
    appointmentsLastMonth: number;
    appointmentsChangePercent: number | null;
    newClientsThisMonth: number;
    newClientsLastMonth: number;
    newClientsChangePercent: number | null;
  };
}

const RETENTION_ACTOR = "system:retention";

export default function TenantDetailPage() {
  const t = useTranslations();
  const params = useParams();
  const tenantId = (params?.id as string) ?? "";
  const [tenant, setTenant] = useState<Tenant | null>(null);
  const [stats, setStats] = useState<TenantStats | null>(null);
  const [growth, setGrowth] = useState<GrowthMetrics | null>(null);
  const [requests, setRequests] = useState<SaasGdprRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();

  const [pendingStatus, setPendingStatus] = useState<TenantAction | null>(null);

  const [exporting, setExporting] = useState(false);
  const [anonymizeOpen, setAnonymizeOpen] = useState(false);
  const [confirmName, setConfirmName] = useState("");
  const [force, setForce] = useState(false);
  const [anonymizing, setAnonymizing] = useState(false);
  const [anonymizeError, setAnonymizeError] = useState<string | null>(null);

  const loadRequests = useCallback(async () => {
    try {
      setRequests(await apiClient.getSaasTenantGdprRequests(tenantId));
    } catch (err) {
      console.error("Error loading GDPR requests:", err);
    }
  }, [tenantId]);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      setError(null);
      const tenantData: Tenant = await apiClient.getSaasTenant(tenantId);
      setTenant(tenantData);
      // The figures 404 for a deleted salon: the page still opens without them.
      const [statsData, growthData] = await Promise.all([
        apiClient.getSaasTenantStats(tenantId).catch(() => null),
        apiClient.getSalonGrowthMetrics(tenantId, 6).catch(() => null),
      ]);
      setStats(statsData);
      setGrowth(growthData);
      void loadRequests();
    } catch (err) {
      console.error("Error fetching tenant:", err);
      setError(t("saas.failedToLoadTenant"));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId, loadRequests]);

  useEffect(() => {
    void load();
  }, [load]);

  const handleExport = async () => {
    setExporting(true);
    try {
      const { blob, filename } = await apiClient.downloadSaasTenantExport(tenantId);
      saveBlob(blob, filename);
      toast({ title: t("saas.console.gdpr_export_ok") });
    } catch (err) {
      toast({
        title: t("saas.console.gdpr_export_failed"),
        description: (err as Error)?.message,
        variant: "destructive",
      });
    } finally {
      setExporting(false);
      void loadRequests();
    }
  };

  const openAnonymize = () => {
    setConfirmName("");
    setForce(false);
    setAnonymizeError(null);
    setAnonymizeOpen(true);
  };

  const performAnonymize = async () => {
    if (!tenant) return;
    setAnonymizing(true);
    setAnonymizeError(null);
    try {
      await apiClient.anonymizeSaasTenant(tenantId, { confirmName, force: force || undefined });
      setAnonymizeOpen(false);
      toast({ title: t("saas.console.gdpr_anonymize_ok") });
      await load();
    } catch (err) {
      setAnonymizeError((err as Error)?.message || t("saas.console.gdpr_anonymize_failed"));
      void loadRequests();
    } finally {
      setAnonymizing(false);
    }
  };

  if (loading && !tenant) {
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
            {t("saas.console.back_to_salons")}
          </Link>
        </div>
      </div>
    );
  }

  const deleted = !!tenant.deletedAt;
  const anonymized = !!tenant.anonymizedAt;
  const statusKey = tenantStatusKey(tenant.subscriptionStatus);
  const needsForce = anonymizeNeedsForce(tenant);
  const nameMatches = sameSalonName(confirmName, tenant.name);
  const nextStepLabel =
    tenant.retention.nextStep === "warn"
      ? t("saas.console.next_step_warn")
      : tenant.retention.nextStep === "anonymize"
        ? t("saas.console.next_step_anonymize")
        : t("saas.console.next_step_none");

  const row = (label: string, value: React.ReactNode) => (
    <div className="flex justify-between gap-4">
      <dt className="text-gray-500">{label}</dt>
      <dd className="text-gray-900 text-right break-all">{value}</dd>
    </div>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:space-x-4 min-w-0">
          <Link
            href="/saas/tenants"
            aria-label={t("saas.console.back_to_salons")}
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
          <span
            className={`inline-flex items-center px-3 py-1 rounded-full text-sm font-medium ${tenantStatusClass(tenant.subscriptionStatus)}`}
          >
            {tenant.subscriptionStatus === "active" && <CheckCircle className="w-4 h-4 mr-1" />}
            {tenant.subscriptionStatus === "cancelled" && <XCircle className="w-4 h-4 mr-1" />}
            {statusKey ? t(statusKey) : tenant.subscriptionStatus}
          </span>
          {deleted && (
            <span className="inline-flex items-center px-3 py-1 rounded-full text-sm font-medium bg-gray-200 text-gray-800">
              {t("saas.deleted_badge")}
            </span>
          )}
          <TenantStatusExtraBadges tenant={tenant} />
          {!deleted && (
            <>
              <Link
                href={`/saas/tenants/${tenant.id}/edit`}
                className="inline-flex items-center px-4 py-2 border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
              >
                <Edit className="w-4 h-4 mr-2" />
                {t("saas.console.edit")}
              </Link>
              <TenantStatusButtons tenant={tenant} onAsk={setPendingStatus} />
            </>
          )}
        </div>
      </div>

      {deleted && (
        <div role="status" className="rounded-lg border border-gray-300 bg-gray-50 p-4 text-gray-800">
          {t("saas.console.deleted_banner", { date: formatDateEs(tenant.deletedAt, true) })}
        </div>
      )}
      {anonymized && (
        <div role="status" className="rounded-lg border border-gray-300 bg-gray-50 p-4 text-gray-800">
          {t("saas.console.anonymized_banner", { date: formatDateEs(tenant.anonymizedAt, true) })}
        </div>
      )}
      {tenant.deletionRequestedAt && !deleted && (
        <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900">
          {t("saas.console.pending_deletion_banner", { date: formatDateEs(tenant.deletionRequestedAt) })}
        </div>
      )}

      <SharedIdentityNotice warnings={tenant.sharedIdentity} />

      {/* Stats with Growth */}
      {stats && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="p-2 bg-slate-100 rounded-lg">
                <Users className="w-5 h-5 text-slate-700" />
              </div>
              {growth && <GrowthIndicator value={growth.summary.newClientsChangePercent} />}
            </div>
            <h3 className="text-2xl font-bold text-gray-900">{stats.totalClients || 0}</h3>
            <p className="text-gray-500 text-sm">{t("saas.metrics.total_clients")}</p>
            {growth && (
              <p className="text-gray-400 text-xs mt-1">
                {t("saas.metrics.new_clients_month", { n: growth.summary.newClientsThisMonth })}
              </p>
            )}
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="p-2 bg-slate-100 rounded-lg">
                <Calendar className="w-5 h-5 text-slate-700" />
              </div>
              <GrowthIndicator value={stats.appointmentsChange} />
            </div>
            <h3 className="text-2xl font-bold text-gray-900">{stats.totalAppointments || 0}</h3>
            <p className="text-gray-500 text-sm">{t("saas.metrics.appointments")}</p>
            <p className="text-gray-400 text-xs mt-1">
              {t("saas.metrics.appointments_month", { n: stats.appointmentsThisMonth || 0 })}
            </p>
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-6">
            <div className="flex items-center justify-between mb-4">
              <div className="p-2 bg-slate-100 rounded-lg">
                <DollarSign className="w-5 h-5 text-slate-700" />
              </div>
              <GrowthIndicator value={stats.salonTakingsChange} />
            </div>
            {/* Already euros (Appointment.price): not cents. The salon's money, not KiraRoom's. */}
            <h3 className="text-2xl font-bold text-gray-900">{formatEuros(stats.salonTakingsTotal)}</h3>
            <p className="text-gray-500 text-sm">{t("saas.metrics.salon_takings")}</p>
            <p className="text-gray-400 text-xs mt-1">
              {t("saas.metrics.salon_takings_month", { amount: formatEuros(stats.salonTakingsThisMonth) })}
            </p>
          </div>
        </div>
      )}

      {/* Growth Evolution Charts */}
      {growth && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
          <LineChart
            data={growth.salonTakingsEvolution.map((d) => ({
              month: d.month,
              value: d.value,
            }))}
            title={t("saas.metrics.salon_takings")}
            valueSuffix=" €"
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
          <h2 className="text-lg font-semibold text-gray-900 mb-4">{t("saas.console.salon_details")}</h2>
          <dl className="space-y-3">
            {row(
              t("saas.console.owner"),
              tenant.owner
                ? [tenant.owner.firstName, tenant.owner.lastName].filter(Boolean).join(" ") +
                    (tenant.owner.email ? ` · ${tenant.owner.email}` : "")
                : t("saas.console.no_owner"),
            )}
            {row(t("saas.console.description"), tenant.description || "—")}
            {row(t("saas.console.email"), tenant.email || "—")}
            {row(t("saas.console.phone"), tenant.phone || "—")}
            {row(t("saas.console.website"), tenant.website || "—")}
            {row(t("saas.console.country"), tenant.country)}
            {row(t("saas.console.timezone"), tenant.timezone)}
            {row(t("saas.console.currency"), tenant.currency)}
          </dl>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">{t("saas.console.counts")}</h2>
          <dl className="space-y-3">
            {row(t("saas.console.users"), tenant.userCount)}
            {row(t("saas.console.total_clients"), tenant.clientCount)}
            {row(t("saas.console.professionals"), tenant.professionalCount)}
            {row(t("saas.console.services"), tenant.serviceCount || 0)}
            {row(t("saas.console.total_appointments"), tenant.appointmentCount)}
            {row(t("saas.console.plan"), <span className="capitalize">{tenant.plan}</span>)}
            {row(t("saas.console.created"), formatDateEs(tenant.createdAt))}
          </dl>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t("saas.console.subscription_section")}</h2>
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:gap-x-8">
          {row(t("saas.console.status"), statusKey ? t(statusKey) : tenant.subscriptionStatus)}
          {row(t("saas.console.trial_end"), formatDateEs(tenant.trialEnd))}
          {row(t("saas.console.period_end"), formatDateEs(tenant.currentPeriodEnd))}
          {row(
            t("saas.console.stripe_subscription"),
            tenant.hasStripeSubscription ? t("saas.console.yes") : t("saas.console.no"),
          )}
          {row(t("saas.console.read_only_until"), formatDateEs(tenant.retention.readOnlyUntil))}
          {row(t("saas.console.anonymize_on"), formatDateEs(tenant.retention.anonymizeOn))}
          {row(t("saas.console.warned_at"), formatDateEs(tenant.retention.warnedAt, true))}
          {row(t("saas.console.next_step"), nextStepLabel)}
        </dl>
      </div>

      {/* Datos y RGPD (audit 8 T12 / D14) */}
      <div className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">{t("saas.console.gdpr_section")}</h2>
          <p className="text-sm text-gray-500 mt-1">{t("saas.console.gdpr_intro")}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            onClick={handleExport}
            disabled={exporting}
            className="inline-flex items-center px-4 py-2 border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            <Download className="w-4 h-4 mr-2" />
            {exporting ? t("saas.console.gdpr_exporting") : t("saas.console.gdpr_export")}
          </button>
          {!anonymized && (
            <button
              onClick={openAnonymize}
              className="inline-flex items-center px-4 py-2 border border-red-200 rounded-lg text-red-700 hover:bg-red-50 transition-colors"
            >
              <ShieldAlert className="w-4 h-4 mr-2" />
              {t("saas.console.gdpr_anonymize")}
            </button>
          )}
        </div>
        <div>
          <h3 className="text-sm font-medium text-gray-900 mb-2">{t("saas.console.gdpr_history")}</h3>
          {requests.length === 0 ? (
            <p className="text-sm text-gray-500">{t("saas.console.gdpr_history_empty")}</p>
          ) : (
            <ul className="divide-y divide-gray-100 text-sm">
              {requests.map((r) => (
                <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                  <span className="text-gray-900">
                    {t(r.action === "export" ? "saas.console.gdpr_action_export" : "saas.console.gdpr_action_anonymize")}
                    {r.actorId === RETENTION_ACTOR && (
                      <span className="text-gray-500"> · {t("saas.console.gdpr_by_retention")}</span>
                    )}
                  </span>
                  <span className="text-gray-500">{formatDateEs(r.createdAt, true)}</span>
                  <span
                    className={
                      r.status === "completed"
                        ? "text-indigo-700"
                        : r.status === "failed"
                          ? "text-red-700"
                          : "text-amber-700"
                    }
                  >
                    {t(`saas.console.gdpr_status_${r.status}`)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {stats && (
        <Link
          href={`/saas/tenants/${tenant.id}/analytics`}
          className="inline-flex items-center px-4 py-2 bg-slate-100 text-slate-700 rounded-lg hover:bg-slate-200 transition-colors"
        >
          <TrendingUp className="w-4 h-4 mr-2" />
          {t("saas.console.full_analytics")}
        </Link>
      )}

      <TenantStatusDialog
        tenant={pendingStatus ? tenant : null}
        action={pendingStatus}
        onClose={() => setPendingStatus(null)}
        onDone={() => void load()}
      />

      <ConfirmDialog
        open={anonymizeOpen}
        title={t("saas.console.gdpr_anonymize_title", { name: tenant.name })}
        description={
          <div className="space-y-3">
            <p>{t("saas.console.gdpr_anonymize_desc")}</p>
            <label className="block">
              <span className="block text-sm font-medium text-gray-700 mb-1">{t("saas.console.gdpr_type_name")}</span>
              <input
                type="text"
                value={confirmName}
                onChange={(e) => setConfirmName(e.target.value)}
                autoComplete="off"
                placeholder={tenant.name}
                className="w-full px-3 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent"
              />
            </label>
            {needsForce && (
              <div className="rounded border border-amber-200 bg-amber-50 p-3 text-amber-900">
                <p>{t("saas.console.gdpr_force_hint")}</p>
                <label className="mt-2 flex items-center gap-2">
                  <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} />
                  {t("saas.console.gdpr_force")}
                </label>
              </div>
            )}
            {anonymizeError && (
              <p role="alert" className="text-red-700">
                <strong>{t("saas.console.gdpr_anonymize_failed")}:</strong> {anonymizeError}
              </p>
            )}
          </div>
        }
        confirmLabel={anonymizeError ? t("saas.console.retry") : t("saas.console.gdpr_anonymize")}
        cancelLabel={t("common.cancel")}
        destructive
        loading={anonymizing}
        confirmDisabled={!nameMatches || (needsForce && !force)}
        onCancel={() => setAnonymizeOpen(false)}
        onConfirm={performAnonymize}
      />
    </div>
  );
}
