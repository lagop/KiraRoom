"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams, useRouter } from "next/navigation";
import { AlertCircle, ExternalLink, RefreshCw } from "lucide-react";
import apiClient from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { formatDateEs } from "@/lib/saas-tenant";
import {
  type BillingInvoiceList,
  type BillingMode,
  type BillingSummary,
  INVOICE_STATUSES,
  formatCents,
  invoiceAmountCents,
  invoiceStatusClass,
  invoiceStatusKey,
  monthTitle,
  safeStripeUrl,
} from "@/lib/saas-billing";

const PAGE_SIZE = 25;

/** What KiraRoom has charged the salons for their plans: takings per month and every invoice. */
function BillingContent() {
  const t = useTranslations();
  const router = useRouter();
  const params = useSearchParams();
  const tenantId = params.get("tenantId") ?? "";

  const [mode, setMode] = useState<BillingMode | "">("");
  const [status, setStatus] = useState("");
  const [month, setMonth] = useState("");
  const [page, setPage] = useState(1);
  const [summary, setSummary] = useState<BillingSummary | null>(null);
  const [list, setList] = useState<BillingInvoiceList | null>(null);
  const [error, setError] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMessage, setSyncMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    setError(false);
    try {
      const [s, l] = await Promise.all([
        apiClient.getSaasBillingSummary({ mode: mode || undefined, months: 12 }),
        apiClient.getSaasBillingInvoices({
          mode: mode || undefined,
          status: status || undefined,
          month: month || undefined,
          tenantId: tenantId || undefined,
          page,
          limit: PAGE_SIZE,
        }),
      ]);
      setSummary(s as BillingSummary);
      setList(l as BillingInvoiceList);
      // First load: show the mode the server chose (the platform's own).
      setMode((current) => current || (l as BillingInvoiceList).mode);
    } catch {
      setError(true);
    }
  }, [mode, status, month, tenantId, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const sync = async () => {
    setSyncing(true);
    setSyncMessage(null);
    try {
      const r = await apiClient.syncSaasBilling();
      setSyncMessage({ ok: true, text: t("saas.billing.sync_ok", { recorded: r.recorded, skipped: r.skipped }) });
      await load();
    } catch {
      setSyncMessage({ ok: false, text: t("saas.billing.sync_failed") });
    } finally {
      setSyncing(false);
    }
  };

  const pick = (m: BillingMode) => {
    setMode(m);
    setPage(1);
  };

  if (error && !list) {
    return (
      <div className="bg-red-50 border border-red-200 rounded-lg p-6 flex items-center gap-3 text-red-700">
        <AlertCircle className="w-5 h-5 shrink-0" />
        {t("saas.billing.load_error")}
      </div>
    );
  }
  if (!summary || !list) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="animate-spin w-12 h-12 border-4 border-slate-800 border-t-transparent rounded-full"></div>
      </div>
    );
  }

  const pages = Math.max(1, Math.ceil(list.total / list.limit));
  const salonName = list.items[0]?.tenantName ?? tenantId.slice(0, 8);
  const modeButton = (m: BillingMode, label: string) => (
    <button
      key={m}
      onClick={() => pick(m)}
      aria-pressed={mode === m}
      className={`px-3 py-1.5 text-sm rounded-lg border ${
        mode === m ? "bg-slate-800 text-white border-slate-800" : "bg-white text-gray-700 border-gray-200 hover:bg-gray-50"
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t("saas.billing.title")}</h1>
          <p className="text-gray-500 mt-1 max-w-2xl">{t("saas.billing.subtitle")}</p>
        </div>
        <div className="text-right">
          <button
            onClick={sync}
            disabled={syncing}
            className="inline-flex items-center gap-2 px-4 py-2 border border-gray-200 rounded-lg text-gray-700 hover:bg-gray-50 disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${syncing ? "animate-spin" : ""}`} />
            {syncing ? t("saas.billing.syncing") : t("saas.billing.sync")}
          </button>
          <p className="text-xs text-gray-500 mt-1 max-w-xs">{t("saas.billing.sync_hint")}</p>
        </div>
      </div>

      {syncMessage && (
        <div
          role="status"
          className={`rounded-lg border p-3 text-sm ${
            syncMessage.ok ? "bg-green-50 border-green-200 text-green-800" : "bg-red-50 border-red-200 text-red-700"
          }`}
        >
          {syncMessage.text}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-gray-600">{t("saas.billing.mode_label")}:</span>
        {modeButton("live", t("saas.billing.mode_live"))}
        {modeButton("test", t("saas.billing.mode_test"))}
        {modeButton("all", t("saas.billing.mode_all"))}
      </div>
      {mode !== "live" && (
        <div className="rounded-lg border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800">
          {t("saas.billing.mode_test_notice")}
        </div>
      )}

      <section className="bg-white rounded-xl border border-gray-200 p-6">
        <h2 className="text-lg font-semibold text-gray-900 mb-4">{t("saas.billing.summary_title")}</h2>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b border-gray-200">
                <th className="py-2 pr-4 font-medium">{t("saas.billing.month")}</th>
                <th className="py-2 pr-4 font-medium text-right">{t("saas.billing.collected")}</th>
                <th className="py-2 pr-4 font-medium text-right">{t("saas.billing.refunded")}</th>
                <th className="py-2 pr-4 font-medium text-right">{t("saas.billing.net")}</th>
                <th className="py-2 pr-4 font-medium text-right">{t("saas.billing.paid_count")}</th>
                <th className="py-2 font-medium text-right">{t("saas.billing.failed_count")}</th>
              </tr>
            </thead>
            <tbody>
              {summary.months.map((m) => (
                <tr key={m.month} className="border-b border-gray-100">
                  <td className="py-2 pr-4 capitalize">{monthTitle(m.month)}</td>
                  <td className="py-2 pr-4 text-right">{formatCents(m.collectedCents)}</td>
                  <td className="py-2 pr-4 text-right">{formatCents(m.refundedCents)}</td>
                  <td className="py-2 pr-4 text-right font-medium">{formatCents(m.netCents)}</td>
                  <td className="py-2 pr-4 text-right">{m.paidCount}</td>
                  <td className="py-2 text-right">
                    {m.failedCount > 0 ? `${m.failedCount} · ${formatCents(m.failedCents)}` : "—"}
                  </td>
                </tr>
              ))}
              <tr className="font-semibold">
                <td className="py-2 pr-4">{t("saas.billing.totals")}</td>
                <td className="py-2 pr-4 text-right">{formatCents(summary.totals.collectedCents)}</td>
                <td className="py-2 pr-4 text-right">{formatCents(summary.totals.refundedCents)}</td>
                <td className="py-2 pr-4 text-right">{formatCents(summary.totals.netCents)}</td>
                <td className="py-2 pr-4" />
                <td className="py-2 text-right">{summary.totals.failedCount || "—"}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="bg-white rounded-xl border border-gray-200 p-6 space-y-4">
        <div className="flex flex-wrap items-end gap-4">
          <h2 className="text-lg font-semibold text-gray-900 mr-auto">{t("saas.billing.invoices_title")}</h2>
          {tenantId && (
            <button
              onClick={() => {
                router.push("/saas/cobros");
                setPage(1);
              }}
              className="text-sm text-indigo-700 hover:underline"
            >
              {t("saas.billing.salon_filter", { name: salonName })} · {t("saas.billing.clear_salon")}
            </button>
          )}
          <label className="text-sm text-gray-600">
            {t("saas.billing.filter_status")}
            <select
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setPage(1);
              }}
              className="ml-2 border border-gray-200 rounded-lg px-2 py-1.5"
            >
              <option value="">{t("saas.billing.all")}</option>
              {INVOICE_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {t(invoiceStatusKey(s) as string)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-sm text-gray-600">
            {t("saas.billing.filter_month")}
            <select
              value={month}
              onChange={(e) => {
                setMonth(e.target.value);
                setPage(1);
              }}
              className="ml-2 border border-gray-200 rounded-lg px-2 py-1.5"
            >
              <option value="">{t("saas.billing.all_months")}</option>
              {summary.months.map((m) => (
                <option key={m.month} value={m.month}>
                  {monthTitle(m.month)}
                </option>
              ))}
            </select>
          </label>
        </div>

        {list.items.length === 0 ? (
          <p className="text-sm text-gray-500 py-6">{t("saas.billing.empty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm">
              <thead>
                <tr className="text-left text-gray-500 border-b border-gray-200">
                  <th className="py-2 pr-4 font-medium">{t("saas.billing.col_date")}</th>
                  <th className="py-2 pr-4 font-medium">{t("saas.billing.col_salon")}</th>
                  <th className="py-2 pr-4 font-medium">{t("saas.billing.col_number")}</th>
                  <th className="py-2 pr-4 font-medium">{t("saas.billing.col_description")}</th>
                  <th className="py-2 pr-4 font-medium text-right">{t("saas.billing.col_amount")}</th>
                  <th className="py-2 pr-4 font-medium">{t("saas.billing.col_status")}</th>
                  <th className="py-2 font-medium">{t("saas.billing.col_links")}</th>
                </tr>
              </thead>
              <tbody>
                {list.items.map((inv) => {
                  const key = invoiceStatusKey(inv.status);
                  const view = safeStripeUrl(inv.hostedInvoiceUrl);
                  const pdf = safeStripeUrl(inv.invoicePdfUrl);
                  return (
                    <tr key={inv.id} className="border-b border-gray-100">
                      <td className="py-2 pr-4 whitespace-nowrap">{formatDateEs(inv.paidAt ?? inv.failedAt ?? inv.invoiceCreatedAt)}</td>
                      <td className="py-2 pr-4">
                        {inv.tenantId ? (
                          <Link href={`/saas/tenants/${inv.tenantId}`} className="text-indigo-700 hover:underline">
                            {inv.tenantName}
                          </Link>
                        ) : (
                          inv.tenantName
                        )}
                      </td>
                      <td className="py-2 pr-4">{inv.number ?? "—"}</td>
                      <td className="py-2 pr-4">{inv.description ?? "—"}</td>
                      <td className="py-2 pr-4 text-right whitespace-nowrap">
                        {formatCents(invoiceAmountCents(inv))}
                        {inv.amountRefundedCents > 0 && (
                          <span className="block text-xs text-gray-500">−{formatCents(inv.amountRefundedCents)}</span>
                        )}
                      </td>
                      <td className="py-2 pr-4">
                        <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${invoiceStatusClass(inv.status)}`}>
                          {key ? t(key) : inv.status}
                        </span>
                      </td>
                      <td className="py-2 whitespace-nowrap">
                        {view && (
                          <a href={view} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-indigo-700 hover:underline mr-3">
                            {t("saas.billing.view_invoice")} <ExternalLink className="w-3 h-3" />
                          </a>
                        )}
                        {pdf && (
                          <a href={pdf} target="_blank" rel="noopener noreferrer" className="text-indigo-700 hover:underline">
                            {t("saas.billing.download_pdf")}
                          </a>
                        )}
                        {!view && !pdf && "—"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {pages > 1 && (
          <div className="flex items-center justify-between pt-2 text-sm">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-1.5 border border-gray-200 rounded-lg disabled:opacity-40"
            >
              {t("saas.billing.prev")}
            </button>
            <span className="text-gray-600">{t("saas.billing.page_of", { page, pages })}</span>
            <button
              onClick={() => setPage((p) => Math.min(pages, p + 1))}
              disabled={page >= pages}
              className="px-3 py-1.5 border border-gray-200 rounded-lg disabled:opacity-40"
            >
              {t("saas.billing.next")}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

export default function SaasBillingPage() {
  return (
    <Suspense fallback={null}>
      <BillingContent />
    </Suspense>
  );
}
