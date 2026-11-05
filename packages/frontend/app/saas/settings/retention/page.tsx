"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertCircle, ShieldAlert } from "lucide-react";
import apiClient, { PlatformRetentionConfig } from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { useToast } from "@/components/ui/use-toast";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { WeeklyDigest, weeklyDate } from "@/lib/console-weekly";
import { needsConfirmation, retentionView } from "@/lib/platform-retention";

/**
 * The switch of the retention job (saas/retention on the server), for the
 * saas_owner: off, it only lists what it would do (dry run); on, it warns
 * the owners of salons that left and anonymises them for real. Turning it
 * on is confirmed first; every change is audit-logged by the server.
 */
export default function PlatformRetentionPage() {
  const t = useTranslations();
  const { toast } = useToast();
  const [cfg, setCfg] = useState<PlatformRetentionConfig | null>(null);
  const [items, setItems] = useState<WeeklyDigest["retention"]["items"] | null>(null);
  const [itemsError, setItemsError] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiClient
      .getPlatformRetentionConfig()
      .then(setCfg)
      .catch(() => setLoadError(true));
    // The dry-run list is the one of "Esta semana".
    apiClient
      .getSaasWeekly()
      .then((d: WeeklyDigest) => setItems(d.retention.items))
      .catch(() => setItemsError(true));
  }, []);

  async function save(enabled: boolean) {
    setSaving(true);
    try {
      const next = await apiClient.updatePlatformRetentionConfig(enabled);
      setCfg(next);
      toast(
        enabled
          ? { title: t("saas.retention_setting.saved_on"), description: t("saas.retention_setting.saved_on_detail") }
          : { title: t("saas.retention_setting.saved_off") },
      );
      setConfirming(false);
    } catch (err) {
      toast({ title: t("saas.retention_setting.failed"), description: (err as Error)?.message, variant: "destructive" });
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  }

  function flip() {
    if (!cfg) return;
    if (needsConfirmation(cfg)) setConfirming(true);
    else void save(false);
  }

  if (loadError) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 flex items-center gap-3 text-red-700">
        <AlertCircle className="w-5 h-5 shrink-0" />
        {t("saas.retention_setting.load_error")}
      </div>
    );
  }
  if (!cfg) return <div className="text-gray-500">…</div>;

  const view = retentionView(cfg);
  const tone = view === "dry_run" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-red-200 bg-red-50 text-red-900";
  const stateKey = view === "dry_run" ? "state_off" : view === "on" ? "state_on" : "state_env";

  return (
    <div className="space-y-6 max-w-3xl">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{t("saas.retention_setting.title")}</h1>
        <p className="text-gray-500 mt-1">{t("saas.retention_setting.description")}</p>
      </div>

      <div className={`flex items-start gap-3 rounded-lg border p-4 text-sm ${tone}`}>
        <ShieldAlert className="w-5 h-5 mt-0.5 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-semibold">{t(`saas.retention_setting.${stateKey}`)}</p>
          <p>{t(`saas.retention_setting.${stateKey}_detail`)}</p>
        </div>
      </div>

      <div className="bg-white border border-gray-200 rounded-xl p-6 space-y-3">
        <div className="flex items-center justify-between gap-4">
          <span id="retention-switch-label" className="text-sm font-medium text-gray-900">
            {t("saas.retention_setting.switch_label")}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={cfg.enabled}
            aria-labelledby="retention-switch-label"
            disabled={saving}
            onClick={flip}
            className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
              cfg.enabled ? "bg-red-600" : "bg-gray-300"
            }`}
          >
            <span className={`inline-block h-5 w-5 rounded-full bg-white shadow transition-transform ${cfg.enabled ? "translate-x-5" : "translate-x-0.5"}`} />
          </button>
        </div>
        <p className="text-xs text-gray-500">
          {cfg.updatedAt
            ? t("saas.retention_setting.last_change", { date: weeklyDate(cfg.updatedAt), by: cfg.updatedBy ?? "?" })
            : t("saas.retention_setting.never_changed")}
        </p>
      </div>

      <section className="bg-white border border-gray-200 rounded-xl p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-3">
          {t("saas.retention_setting.list_title")}
          {items ? <span className="text-gray-400 font-normal"> ({items.length})</span> : null}
        </h2>
        {itemsError && <p className="text-sm text-red-600">{t("saas.retention_setting.list_load_error")}</p>}
        {items && items.length === 0 && <p className="text-sm text-gray-400">{t("saas.retention_setting.list_empty")}</p>}
        <div className="space-y-2">
          {items?.map((r) => (
            <div key={r.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 text-sm">
              <Link href={`/saas/tenants/${r.id}`} className="font-medium text-indigo-700 hover:underline min-w-0 truncate">
                {r.name}
              </Link>
              <span className="text-gray-600 sm:text-right">
                {r.kind === "warn" ? t("saas.weekly.retention_warn") : t("saas.weekly.retention_anonymize")}
                {r.dueNow ? ` (${t("saas.weekly.retention_tonight")})` : ""} · {t("saas.weekly.retention_row", { date: weeklyDate(r.anonymizeOn) })}
              </span>
            </div>
          ))}
        </div>
        <Link href="/saas/weekly#retention" className="inline-block mt-3 text-sm font-medium text-indigo-600 hover:text-indigo-800">
          {t("saas.retention_setting.open_weekly")}
        </Link>
      </section>

      <ConfirmDialog
        open={confirming}
        title={t("saas.retention_setting.confirm_title")}
        description={t("saas.retention_setting.confirm_body")}
        confirmLabel={t("saas.retention_setting.confirm_label")}
        destructive
        loading={saving}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void save(true)}
      />
    </div>
  );
}
