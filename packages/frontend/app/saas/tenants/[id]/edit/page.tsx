"use client";

import { useState, useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import { ArrowLeft, Save } from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { SALON_TIMEZONES } from "@kira/shared";
import { editableStatuses, formatDateEs, tenantStatusKey } from "@/lib/saas-tenant";

interface FormData {
  name: string;
  /** The web address: a change keeps the old one redirecting for 12 months (T21). */
  slug: string;
  description: string;
  email: string;
  phone: string;
  website: string;
  country: string;
  timezone: string;
  currency: string;
  plan: string;
  subscriptionStatus: string;
  /** yyyy-mm-dd; empty = unchanged. */
  trialEnd: string;
}

const EMPTY: FormData = {
  name: "",
  slug: "",
  description: "",
  email: "",
  phone: "",
  website: "",
  country: "",
  timezone: "",
  currency: "",
  plan: "",
  subscriptionStatus: "",
  trialEnd: "",
};

const inputClass =
  "w-full px-3 py-2 border border-gray-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500";

export default function EditTenantPage() {
  const t = useTranslations();
  const params = useParams();
  const router = useRouter();
  const tenantId = (params?.id as string) ?? "";
  const [loading, setLoading] = useState(false);
  const [fetching, setFetching] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [deleted, setDeleted] = useState(false);
  const [deletionRequestedAt, setDeletionRequestedAt] = useState<string | null>(null);
  const [currentTrialEnd, setCurrentTrialEnd] = useState<string | null>(null);
  // D7: a platform word or brand name in the address, for the platform's own salons.
  const [platformAddress, setPlatformAddress] = useState(false);
  const [original, setOriginal] = useState<FormData>(EMPTY);
  const [formData, setFormData] = useState<FormData>(EMPTY);

  useEffect(() => {
    const fetchTenant = async () => {
      try {
        const tenant = await apiClient.getSaasTenant(tenantId);
        const data: FormData = {
          name: tenant.name || "",
          slug: tenant.slug || "",
          description: tenant.description || "",
          email: tenant.email || "",
          phone: tenant.phone || "",
          website: tenant.website || "",
          country: tenant.country || "",
          timezone: tenant.timezone || "",
          currency: tenant.currency || "",
          plan: tenant.plan || "",
          subscriptionStatus: tenant.subscriptionStatus || "",
          trialEnd: "",
        };
        setOriginal(data);
        setFormData(data);
        setDeleted(!!tenant.deletedAt);
        setDeletionRequestedAt(tenant.deletionRequestedAt ?? null);
        setCurrentTrialEnd(tenant.trialEnd ?? null);
      } catch (err) {
        console.error("Error fetching tenant:", err);
        setError(t("saas.failedToLoadTenant"));
      } finally {
        setFetching(false);
      }
    };

    fetchTenant();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tenantId]);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    // Only what changed: an untouched status or plan is not re-validated (T13).
    const body: Record<string, unknown> = {};
    for (const key of Object.keys(formData) as (keyof FormData)[]) {
      if (key === "trialEnd") continue;
      if (formData[key] !== original[key]) body[key] = formData[key];
    }
    if (formData.trialEnd) body.trialEnd = new Date(`${formData.trialEnd}T23:59:59`).toISOString();
    if (body.slug !== undefined && platformAddress) body.platformAddress = true;

    try {
      await apiClient.updateSaasTenant(tenantId, body);
      router.push(`/saas/tenants/${tenantId}`);
    } catch (err) {
      console.error("Error updating tenant:", err);
      setError((err as Error)?.message || t("saas.console.update_failed"));
    } finally {
      setLoading(false);
    }
  };

  if (fetching) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin w-12 h-12 border-4 border-slate-800 border-t-transparent rounded-full"></div>
      </div>
    );
  }

  const header = (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:space-x-4">
      <Link
        href={`/saas/tenants/${tenantId}`}
        aria-label={t("saas.back")}
        className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-lg transition-colors self-start sm:self-auto"
      >
        <ArrowLeft className="w-5 h-5" />
      </Link>
      <div className="min-w-0">
        <h1 className="text-2xl font-bold text-gray-900 truncate">{t("saas.edit_tenant_title")}</h1>
        <p className="text-gray-500 mt-1">{t("saas.updateSalonDesc")}</p>
      </div>
    </div>
  );

  if (deleted) {
    return (
      <div className="space-y-6">
        {header}
        <div role="status" className="rounded-lg border border-gray-300 bg-gray-50 p-4 text-gray-800">
          {t("saas.console.read_only_deleted")}
        </div>
      </div>
    );
  }

  const statusOptions = editableStatuses(original.subscriptionStatus);
  const statusLabel = (s: string) => {
    const key = tenantStatusKey(s);
    return key ? t(key) : s;
  };
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);

  return (
    <div className="space-y-6">
      {header}

      {error && (
        <div role="alert" className="bg-red-50 border border-red-200 rounded-lg p-4">
          <p className="text-red-700">{error}</p>
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-6">
        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">{t("saas.section_salon_info")}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
            <div>
              <label htmlFor="name" className="block text-sm font-medium text-gray-700 mb-1">
                {t("saas.console.salon_name")} *
              </label>
              <input id="name" type="text" name="name" required value={formData.name} onChange={handleChange} className={inputClass} />
            </div>
            <div>
              <label htmlFor="slug" className="block text-sm font-medium text-gray-700 mb-1">
                {t("saas.slug")} *
              </label>
              <input id="slug" type="text" name="slug" required value={formData.slug} onChange={handleChange} className={inputClass} />
              {formData.slug !== original.slug && (
                <p className="text-xs text-gray-500 mt-1">{t("saas.console.web_address_change_hint", { old: original.slug })}</p>
              )}
              <label className="mt-2 flex items-start gap-2 text-sm text-gray-700">
                <input type="checkbox" className="mt-1" checked={platformAddress} onChange={(e) => setPlatformAddress(e.target.checked)} />
                <span>
                  {t("saas.console.platform_address")}
                  <span className="block text-xs text-gray-500">{t("saas.console.platform_address_hint")}</span>
                </span>
              </label>
            </div>
            <div>
              <label htmlFor="description" className="block text-sm font-medium text-gray-700 mb-1">
                {t("saas.console.description")}
              </label>
              <textarea
                id="description"
                name="description"
                rows={3}
                value={formData.description}
                onChange={handleChange}
                className={inputClass}
              />
            </div>
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                {t("saas.console.email")}
              </label>
              <input id="email" type="email" name="email" value={formData.email} onChange={handleChange} className={inputClass} />
            </div>
            <div>
              <label htmlFor="phone" className="block text-sm font-medium text-gray-700 mb-1">
                {t("saas.console.phone")}
              </label>
              <input id="phone" type="tel" name="phone" value={formData.phone} onChange={handleChange} className={inputClass} />
            </div>
            <div>
              <label htmlFor="website" className="block text-sm font-medium text-gray-700 mb-1">
                {t("saas.console.website")}
              </label>
              <input id="website" type="url" name="website" value={formData.website} onChange={handleChange} className={inputClass} />
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">{t("saas.console.section_regional")}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
            <div>
              <label htmlFor="country" className="block text-sm font-medium text-gray-700 mb-1">
                {t("saas.console.country")}
              </label>
              <select id="country" name="country" value={formData.country} onChange={handleChange} className={inputClass}>
                <option value="ES">España</option>
                <option value="PT">Portugal</option>
                <option value="FR">Francia</option>
                <option value="DE">Alemania</option>
                <option value="GB">Reino Unido</option>
                <option value="US">Estados Unidos</option>
                <option value="MX">México</option>
                <option value="AR">Argentina</option>
                <option value="CO">Colombia</option>
                <option value="CL">Chile</option>
              </select>
            </div>
            <div>
              <label htmlFor="timezone" className="block text-sm font-medium text-gray-700 mb-1">
                {t("saas.console.timezone")}
              </label>
              <select id="timezone" name="timezone" value={formData.timezone} onChange={handleChange} className={inputClass}>
                {/* One shared list, in @kira/shared (Canarias included). */}
                {SALON_TIMEZONES.map((tz) => (
                  <option key={tz.value} value={tz.value}>
                    {tz.label}
                  </option>
                ))}
                {/* Keep whatever the tenant already holds selectable, even if
                    it is not on the list (America/Buenos_Aires is a
                    deprecated alias the old selector offered). */}
                {formData.timezone && !SALON_TIMEZONES.some((tz) => tz.value === formData.timezone) && (
                  <option value={formData.timezone}>{formData.timezone}</option>
                )}
              </select>
            </div>
            <div>
              <label htmlFor="currency" className="block text-sm font-medium text-gray-700 mb-1">
                {t("saas.console.currency")}
              </label>
              <select id="currency" name="currency" value={formData.currency} onChange={handleChange} className={inputClass}>
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
                <option value="GBP">GBP</option>
                <option value="MXN">MXN</option>
                <option value="COP">COP</option>
                <option value="ARS">ARS</option>
                <option value="CLP">CLP</option>
              </select>
            </div>
          </div>
        </div>

        <div className="bg-white rounded-xl border border-gray-200 p-6">
          <h2 className="text-lg font-semibold text-gray-900 mb-4">{t("saas.console.section_subscription")}</h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
            <div>
              <label htmlFor="plan" className="block text-sm font-medium text-gray-700 mb-1">
                {t("saas.console.plan")}
              </label>
              <select id="plan" name="plan" value={formData.plan} onChange={handleChange} className={inputClass}>
                <option value="esencial">{t("saas.plan_esencial")}</option>
                <option value="pro">{t("saas.plan_pro")}</option>
                <option value="empresa">{t("saas.plan_empresa")}</option>
              </select>
            </div>
            <div>
              <label htmlFor="subscriptionStatus" className="block text-sm font-medium text-gray-700 mb-1">
                {t("saas.console.status")}
              </label>
              <select
                id="subscriptionStatus"
                name="subscriptionStatus"
                value={formData.subscriptionStatus}
                onChange={handleChange}
                className={inputClass}
              >
                {statusOptions.map((s) => (
                  <option key={s} value={s}>
                    {statusLabel(s)}
                  </option>
                ))}
              </select>
              <p className="text-xs text-gray-500 mt-1">{t("saas.console.status_buttons_hint")}</p>
              <Link href={`/saas/tenants/${tenantId}`} className="text-xs text-indigo-600 hover:underline mt-1 inline-block">
                {t("saas.console.status_buttons_link")}
              </Link>
            </div>
            {(formData.subscriptionStatus === "trialing" || original.subscriptionStatus === "trialing") && (
              <div>
                <label htmlFor="trialEnd" className="block text-sm font-medium text-gray-700 mb-1">
                  {t("saas.console.trial_end_new")}
                </label>
                <input
                  id="trialEnd"
                  type="date"
                  name="trialEnd"
                  min={tomorrow}
                  value={formData.trialEnd}
                  onChange={handleChange}
                  className={inputClass}
                />
                <p className="text-xs text-gray-500 mt-1">
                  {t("saas.console.trial_end")}: {formatDateEs(currentTrialEnd)}. {t("saas.console.trial_end_hint")}
                </p>
              </div>
            )}
          </div>
          {deletionRequestedAt && (
            <p className="mt-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
              {t("saas.console.pending_deletion_notice", { date: formatDateEs(deletionRequestedAt) })}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-end gap-3">
          <Link
            href={`/saas/tenants/${tenantId}`}
            className="px-4 py-2 border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 transition-colors"
          >
            {t("saas.console.cancel")}
          </Link>
          <button
            type="submit"
            disabled={loading}
            className="inline-flex items-center px-4 py-2 bg-slate-900 text-white rounded-lg hover:bg-slate-800 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Save className="w-4 h-4 mr-2" />
            {loading ? t("saas.console.saving") : t("saas.console.save_changes")}
          </button>
        </div>
      </form>
    </div>
  );
}
