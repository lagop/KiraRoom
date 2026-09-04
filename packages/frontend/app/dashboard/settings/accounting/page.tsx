"use client";

import { useEffect, useState } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import apiClient, {
  AccountingConnectionInfo,
  AccountingProvider,
  AccountingSyncLog,
} from "@/lib/api";
import { Loader2, Save, RefreshCcw, Plug, Unplug } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";

export default function AccountingSettingsPage() {
  const t = useTranslations();
  const qc = useQueryClient();
  const settings = useQuery<AccountingConnectionInfo>({
    queryKey: ["accounting", "settings"],
    queryFn: () => apiClient.getAccountingSettings(),
  });
  const logs = useQuery<AccountingSyncLog[]>({
    queryKey: ["accounting", "logs"],
    queryFn: () => apiClient.listAccountingLogs(50),
  });

  const update = useMutation({
    mutationFn: (
      patch: Parameters<typeof apiClient.updateAccountingSettings>[0],
    ) => apiClient.updateAccountingSettings(patch),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["accounting", "settings"] }),
  });
  const connect = useMutation({
    mutationFn: (provider: AccountingProvider) =>
      apiClient.startAccountingOAuth(provider),
  });
  const disconnect = useMutation({
    mutationFn: () => apiClient.disconnectAccounting(),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["accounting", "settings"] }),
  });
  const retry = useMutation({
    mutationFn: () => apiClient.retryAccountingQueue(50),
    onSuccess: () =>
      qc.invalidateQueries({ queryKey: ["accounting", "logs"] }),
  });

  const [draft, setDraft] = useState<{
    enabled: boolean;
    syncOnIssue: boolean;
    provider: AccountingProvider | null;
  }>({ enabled: false, syncOnIssue: true, provider: null });

  useEffect(() => {
    if (settings.data) {
      const s = settings.data.accountingSettings ?? {
        enabled: false,
        syncOnIssue: true,
        provider: null,
      };
      setDraft({
        enabled: Boolean(s.enabled),
        syncOnIssue: Boolean(s.syncOnIssue),
        provider: (s.provider as AccountingProvider | null) ?? null,
      });
    }
  }, [settings.data]);

  if (settings.isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  const conn = settings.data?.accountingConnection;

  async function connectProvider(provider: AccountingProvider) {
    const r = await connect.mutateAsync(provider);
    // Redirect the browser to the provider OAuth URL.
    window.location.href = r.url;
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">
          {t("accounting.title")}
        </h1>
        <p className="mt-1 text-sm text-gray-600">
          {t("accounting.subtitle")}
        </p>
      </header>

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between">
          <div>
            <div className="text-sm font-medium text-gray-900">
              {t("accounting.provider")}
            </div>
            <div className="mt-1 text-sm">
              {conn
                ? t(
                    conn.provider === "holded"
                      ? "accounting.providerHolded"
                      : "accounting.providerSage",
                  )
                : t("accounting.providerNone")}
            </div>
            {conn?.lastSyncAt && (
              <div className="mt-1 text-xs text-gray-500">
                {t("accounting.lastSync")}:{" "}
                {new Date(conn.lastSyncAt).toLocaleString("es-ES")}
              </div>
            )}
            {conn?.lastError && (
              <div className="mt-1 text-xs text-red-600">
                {t("accounting.lastError")}: {conn.lastError}
              </div>
            )}
          </div>
          {conn ? (
            <button
              type="button"
              onClick={() => disconnect.mutate()}
              className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50"
            >
              <Unplug className="h-3 w-3" />
              {t("accounting.disconnect")}
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={connect.isPending}
                onClick={() => connectProvider("holded")}
                className="inline-flex items-center gap-2 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-violet-700 disabled:opacity-50"
              >
                <Plug className="h-3 w-3" />
                {t("accounting.providerHolded")}
              </button>
              <button
                type="button"
                disabled={connect.isPending}
                onClick={() => connectProvider("sage")}
                className="inline-flex items-center gap-2 rounded-md bg-violet-600 px-3 py-1.5 text-xs font-medium text-white shadow-sm hover:bg-violet-700 disabled:opacity-50"
              >
                <Plug className="h-3 w-3" />
                {t("accounting.providerSage")}
              </button>
            </div>
          )}
        </div>

        {!conn && (
          <p className="mt-3 rounded-md bg-amber-50 p-3 text-xs text-amber-800">
            {t("accounting.oauthHint")}
          </p>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="space-y-5">
          <label className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-900">
              {t("accounting.enabled")}
            </span>
            <input
              type="checkbox"
              checked={draft.enabled}
              onChange={(e) =>
                setDraft((d) => ({ ...d, enabled: e.target.checked }))
              }
              className="h-5 w-5 rounded border-gray-300 text-violet-600"
            />
          </label>
          <label className="flex items-center justify-between">
            <span className="text-sm font-medium text-gray-900">
              {t("accounting.syncOnIssue")}
            </span>
            <input
              type="checkbox"
              checked={draft.syncOnIssue}
              onChange={(e) =>
                setDraft((d) => ({ ...d, syncOnIssue: e.target.checked }))
              }
              className="h-5 w-5 rounded border-gray-300 text-violet-600"
            />
          </label>
          <div>
            <label className="text-sm font-medium text-gray-900">
              {t("accounting.provider")}
            </label>
            <select
              value={draft.provider ?? ""}
              onChange={(e) =>
                setDraft((d) => ({
                  ...d,
                  provider: (e.target.value as AccountingProvider) || null,
                }))
              }
              className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
            >
              <option value="">{t("accounting.providerNone")}</option>
              <option value="holded">{t("accounting.providerHolded")}</option>
              <option value="sage">{t("accounting.providerSage")}</option>
            </select>
          </div>
        </div>

        <div className="mt-6 flex justify-end">
          <button
            type="button"
            disabled={update.isPending}
            onClick={() => update.mutate(draft)}
            className="inline-flex items-center gap-2 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-violet-700 disabled:opacity-50"
          >
            {update.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t("invoices.actions.save")}
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900">
            {t("accounting.log")}
          </h2>
          <button
            type="button"
            disabled={retry.isPending}
            onClick={() => retry.mutate()}
            className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-2 py-1 text-xs text-gray-700 hover:bg-gray-50"
          >
            {retry.isPending ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              <RefreshCcw className="h-3 w-3" />
            )}
            {t("accounting.retryQueue")}
          </button>
        </div>
        {retry.data && (
          <p className="mt-2 text-xs text-gray-600">
            {t("accounting.queueStats", {
              attempted: retry.data.attempted,
              synced: retry.data.synced,
              skipped: retry.data.skipped,
              errors: retry.data.errors,
            })}
          </p>
        )}
        {logs.data && logs.data.length > 0 ? (
          <table className="mt-3 w-full text-sm">
            <thead className="text-xs uppercase text-gray-500">
              <tr>
                <th className="text-left">{t("accounting.logDate")}</th>
                <th className="text-left">{t("accounting.logAction")}</th>
                <th className="text-left">{t("accounting.logStatus")}</th>
                <th className="text-left">{t("accounting.logExternalId")}</th>
                <th className="text-left">Error</th>
              </tr>
            </thead>
            <tbody>
              {logs.data.map((log) => (
                <tr key={log.id} className="border-t border-gray-100">
                  <td className="py-1.5 text-xs">
                    {new Date(log.createdAt).toLocaleString("es-ES")}
                  </td>
                  <td className="py-1.5 text-xs">{log.action}</td>
                  <td className="py-1.5 text-xs">
                    <span
                      className={
                        "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium " +
                        (log.status === "ok"
                          ? "bg-green-100 text-green-700"
                          : log.status === "error"
                          ? "bg-red-100 text-red-700"
                          : "bg-gray-100 text-gray-600")
                      }
                    >
                      {log.status}
                    </span>
                  </td>
                  <td className="py-1.5 text-xs font-mono">
                    {log.externalId ?? "—"}
                  </td>
                  <td className="py-1.5 text-xs text-red-600">
                    {log.errorMessage ?? "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="mt-3 text-sm text-gray-500">
            {t("accounting.logEmpty")}
          </p>
        )}
      </div>
    </div>
  );
}