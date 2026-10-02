"use client";

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import apiClient, { AccountingStatus, AccountingSyncLog } from "@/lib/api";
import { getCurrentUser } from "@/lib/utils";
import { useTranslations } from "@/lib/use-translation";
import { Download, KeyRound, Loader2, Send, Unplug } from "lucide-react";
import { Modelo420Card } from "@/components/tax/modelo-420-card";

/**
 * Accounting settings.
 *
 * Says plainly which programs have a direct sync (Holded, via the salon's
 * own API key) and which get the libro de facturas emitidas export (Sage,
 * A3, NCS and anything else): the page used to offer OAuth buttons for
 * Holded and Sage that led to a stub returning made-up ids.
 */

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** First day of the current calendar quarter, the usual export period. */
function quarterStart(now = new Date()): string {
  return isoDay(new Date(Date.UTC(now.getUTCFullYear(), Math.floor(now.getUTCMonth() / 3) * 3, 1)));
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export default function AccountingSettingsPage() {
  const t = useTranslations();
  const qc = useQueryClient();
  const [isOwner, setIsOwner] = useState(false);
  useEffect(() => {
    setIsOwner(getCurrentUser()?.role === "owner");
  }, []);

  const status = useQuery<AccountingStatus>({
    queryKey: ["accounting", "status"],
    queryFn: () => apiClient.getAccountingSettings(),
  });
  const logs = useQuery<AccountingSyncLog[]>({
    queryKey: ["accounting", "logs"],
    queryFn: () => apiClient.listAccountingLogs(50),
    enabled: Boolean(status.data?.connection),
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: ["accounting"] });
  };

  const [apiKey, setApiKey] = useState("");
  const connect = useMutation({
    mutationFn: (key: string) => apiClient.connectHolded(key),
    onSuccess: (data) => {
      setApiKey("");
      qc.setQueryData(["accounting", "status"], data);
      refresh();
    },
  });
  const disconnect = useMutation({
    mutationFn: () => apiClient.disconnectAccounting(),
    onSuccess: refresh,
  });
  const settings = useMutation({
    mutationFn: (syncOnIssue: boolean) => apiClient.updateAccountingSettings({ syncOnIssue }),
    onSuccess: (data) => qc.setQueryData(["accounting", "status"], data),
  });
  const [pushFrom, setPushFrom] = useState("");
  const push = useMutation({
    mutationFn: () => apiClient.pushPendingToHolded(pushFrom || undefined),
    onSuccess: refresh,
  });

  const [from, setFrom] = useState(quarterStart());
  const [to, setTo] = useState(isoDay(new Date()));
  const [exportError, setExportError] = useState<string | null>(null);
  const exportBook = useMutation({
    mutationFn: (format: "csv" | "xlsx") => apiClient.downloadAccountingInvoiceBook(from, to, format),
    onMutate: () => setExportError(null),
    onSuccess: ({ blob, filename }) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
    onError: (err) => setExportError(`${t("accounting.exportFailed")} ${errorMessage(err)}`),
  });

  if (status.isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
      </div>
    );
  }

  const conn = status.data?.connection ?? null;
  const counts = status.data?.invoices;

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <header>
        <h1 className="text-2xl font-bold text-gray-900">{t("accounting.title")}</h1>
        <p className="mt-1 text-sm text-gray-600">{t("accounting.subtitle")}</p>
      </header>

      {/* Which programs get what: no promise this page does not keep. */}
      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-gray-900">{t("accounting.programsTitle")}</h2>
        <dl className="mt-3 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-violet-50 p-3">
            <dt className="text-sm font-medium text-violet-900">{t("accounting.programHolded")}</dt>
            <dd className="mt-1 text-xs text-violet-800">{t("accounting.programHoldedHow")}</dd>
          </div>
          <div className="rounded-lg bg-gray-50 p-3">
            <dt className="text-sm font-medium text-gray-900">{t("accounting.programOthers")}</dt>
            <dd className="mt-1 text-xs text-gray-700">{t("accounting.programOthersHow")}</dd>
          </div>
        </dl>
      </section>

      {/* Holded: direct sync */}
      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-gray-900">{t("accounting.holdedTitle")}</h2>
            {conn ? (
              <div className="mt-1 space-y-0.5 text-xs text-gray-600">
                <div className="text-green-700">
                  {t("accounting.connectedSince", {
                    date: new Date(conn.connectedAt).toLocaleDateString("es-ES"),
                  })}
                </div>
                <div>
                  {t("accounting.lastSync")}:{" "}
                  {conn.lastSyncAt
                    ? new Date(conn.lastSyncAt).toLocaleString("es-ES")
                    : t("accounting.neverSynced")}
                </div>
                {conn.lastError && (
                  <div className="text-red-600">
                    {t("accounting.lastError")}: {conn.lastError}
                  </div>
                )}
              </div>
            ) : (
              <p className="mt-1 text-sm text-gray-600">{t("accounting.holdedIntro")}</p>
            )}
          </div>
          {conn && isOwner && (
            <button
              type="button"
              disabled={disconnect.isPending}
              onClick={() => {
                if (window.confirm(t("accounting.disconnectConfirm"))) disconnect.mutate();
              }}
              className="inline-flex shrink-0 items-center gap-2 rounded-md border border-gray-300 px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <Unplug className="h-3 w-3" />
              {t("accounting.disconnect")}
            </button>
          )}
        </div>

        {!conn &&
          (isOwner ? (
            <form
              className="mt-4 space-y-2"
              onSubmit={(e) => {
                e.preventDefault();
                if (apiKey.trim()) connect.mutate(apiKey.trim());
              }}
            >
              <label htmlFor="holded-key" className="block text-sm font-medium text-gray-900">
                {t("accounting.holdedKeyLabel")}
              </label>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  id="holded-key"
                  type="password"
                  autoComplete="off"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={t("accounting.holdedKeyPlaceholder")}
                  className="block w-full rounded-md border border-gray-300 px-3 py-2 text-sm"
                />
                <button
                  type="submit"
                  disabled={connect.isPending || !apiKey.trim()}
                  className="inline-flex shrink-0 items-center justify-center gap-2 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-violet-700 disabled:opacity-50"
                >
                  {connect.isPending ? (
                    <Loader2 className="h-4 w-4 animate-spin" />
                  ) : (
                    <KeyRound className="h-4 w-4" />
                  )}
                  {connect.isPending ? t("accounting.connecting") : t("accounting.connect")}
                </button>
              </div>
              <p className="text-xs text-gray-500">{t("accounting.holdedScopes")}</p>
              <p className="text-xs text-gray-500">{t("accounting.holdedKeyStored")}</p>
              {connect.error && (
                <p className="text-xs text-red-600">{errorMessage(connect.error)}</p>
              )}
            </form>
          ) : (
            <p className="mt-3 text-xs text-gray-500">{t("accounting.ownerOnly")}</p>
          ))}

        {conn && (
          <div className="mt-5 space-y-5">
            {counts && (
              <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
                {(
                  [
                    ["synced", "accounting.statSynced", "text-green-700"],
                    ["pending", "accounting.statPending", "text-amber-700"],
                    ["error", "accounting.statError", "text-red-700"],
                    ["not_synced", "accounting.statNotSynced", "text-gray-700"],
                  ] as const
                ).map(([key, label, color]) => (
                  <div key={key} className="rounded-lg bg-gray-50 p-2">
                    <div className={`text-lg font-semibold ${color}`}>{counts[key] ?? 0}</div>
                    <div className="text-[11px] text-gray-600">{t(label)}</div>
                  </div>
                ))}
              </div>
            )}

            <label className="flex items-start justify-between gap-4">
              <span>
                <span className="block text-sm font-medium text-gray-900">
                  {t("accounting.syncOnIssue")}
                </span>
                <span className="block text-xs text-gray-500">{t("accounting.syncOnIssueHelp")}</span>
              </span>
              <input
                type="checkbox"
                disabled={!isOwner || settings.isPending}
                checked={status.data?.syncOnIssue ?? true}
                onChange={(e) => settings.mutate(e.target.checked)}
                className="mt-1 h-5 w-5 rounded border-gray-300 text-violet-600"
              />
            </label>

            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1">
                <label htmlFor="push-from" className="block text-xs font-medium text-gray-700">
                  {t("accounting.pushFromLabel")}
                </label>
                <input
                  id="push-from"
                  type="date"
                  value={pushFrom}
                  onChange={(e) => setPushFrom(e.target.value)}
                  className="mt-1 block w-full rounded-md border border-gray-300 px-3 py-1.5 text-sm"
                />
                <p className="mt-1 text-[11px] text-gray-500">{t("accounting.pushFromHelp")}</p>
              </div>
              <button
                type="button"
                disabled={push.isPending}
                onClick={() => push.mutate()}
                className="inline-flex items-center justify-center gap-2 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-violet-700 disabled:opacity-50 sm:mb-5"
              >
                {push.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                {t("accounting.pushPending")}
              </button>
            </div>
            {push.data && (
              <p className="text-xs text-gray-600">
                {t("accounting.pushResult", {
                  synced: push.data.synced,
                  errors: push.data.errors,
                  remaining: push.data.remaining,
                })}
              </p>
            )}
            {push.error && <p className="text-xs text-red-600">{errorMessage(push.error)}</p>}

            <p className="rounded-md bg-amber-50 p-3 text-xs text-amber-900">{t("accounting.howItWorks")}</p>
            <p className="text-xs text-gray-500">{t("accounting.limitsNote")}</p>

            <div>
              <h3 className="text-sm font-semibold text-gray-900">{t("accounting.log")}</h3>
              {logs.data && logs.data.length > 0 ? (
                <div className="mt-2 overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead className="text-xs uppercase text-gray-500">
                      <tr>
                        <th className="text-left">{t("accounting.logDate")}</th>
                        <th className="text-left">{t("accounting.logAction")}</th>
                        <th className="text-left">{t("accounting.logStatus")}</th>
                        <th className="text-left">{t("accounting.logExternalId")}</th>
                        <th className="text-left">{t("accounting.logError")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {logs.data.map((log) => (
                        <tr key={log.id} className="border-t border-gray-100 align-top">
                          <td className="whitespace-nowrap py-1.5 pr-2 text-xs">
                            {new Date(log.createdAt).toLocaleString("es-ES")}
                          </td>
                          <td className="py-1.5 pr-2 text-xs">{log.action}</td>
                          <td className="py-1.5 pr-2 text-xs">
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
                          <td className="py-1.5 pr-2 font-mono text-xs">{log.externalId ?? "—"}</td>
                          <td className="py-1.5 text-xs text-red-600">{log.errorMessage ?? "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="mt-2 text-sm text-gray-500">{t("accounting.logEmpty")}</p>
              )}
            </div>
          </div>
        )}
      </section>

      {/* Export for Sage, A3, NCS and any gestoría */}
      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="text-base font-semibold text-gray-900">{t("accounting.exportTitle")}</h2>
        <p className="mt-1 text-sm text-gray-600">
          {t("accounting.exportIntro", { tax: "IVA / IGIC / IPSI" })}
        </p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-end">
          <div>
            <label htmlFor="export-from" className="block text-xs font-medium text-gray-700">
              {t("accounting.exportFrom")}
            </label>
            <input
              id="export-from"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
              className="mt-1 block rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>
          <div>
            <label htmlFor="export-to" className="block text-xs font-medium text-gray-700">
              {t("accounting.exportTo")}
            </label>
            <input
              id="export-to"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
              className="mt-1 block rounded-md border border-gray-300 px-3 py-1.5 text-sm"
            />
          </div>
          <div className="flex gap-2">
            {(["xlsx", "csv"] as const).map((format) => (
              <button
                key={format}
                type="button"
                disabled={exportBook.isPending || !from || !to}
                onClick={() => exportBook.mutate(format)}
                className="inline-flex items-center gap-2 rounded-md border border-gray-300 px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
              >
                {exportBook.isPending && exportBook.variables === format ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <Download className="h-4 w-4" />
                )}
                {format === "xlsx" ? t("accounting.exportXlsx") : t("accounting.exportCsv")}
              </button>
            ))}
          </div>
        </div>
        <p className="mt-2 text-xs text-gray-500">{t("accounting.exportNote")}</p>
        {exportError && <p className="mt-2 text-xs text-red-600">{exportError}</p>}
      </section>

      <Modelo420Card />
    </div>
  );
}
