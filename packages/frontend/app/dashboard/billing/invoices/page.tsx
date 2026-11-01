"use client";

import { useEffect, useState } from "react";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Ban,
  ChevronLeft,
  ChevronRight,
  FileCode,
  FileDown,
  FileMinus,
  Loader2,
  Mail,
  RefreshCcw,
  Search,
} from "lucide-react";
import apiClient, { Invoice } from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { useTaxRegime } from "@/lib/use-tax-regime";
import { getCurrentUser } from "@/lib/utils";
import { isManager } from "@/lib/dashboard-nav";
import { useToast } from "@/components/ui/use-toast";
import {
  INVOICE_STATUS_FILTERS,
  InvoiceStatusFilter,
  invoiceListQuery,
  invoicePage,
  INVOICE_PAGE_SIZE,
} from "@/lib/invoice-list";
import { CancelInvoiceDialog, EmailInvoiceDialog, RectifyInvoiceDialog } from "./components/invoice-dialogs";

function formatMoney(cents: number, currency = "EUR") {
  return (cents / 100).toLocaleString("es-ES", {
    style: "currency",
    currency,
  });
}

/** Series R or a negative total: a rectificativa (as the backend tells them). */
function isRectifying(invoice: Invoice) {
  return invoice.series === "R" || invoice.totalCents < 0;
}

type Dialog = { kind: "email" | "cancel" | "rectify"; invoice: Invoice } | null;

export default function InvoicesPage() {
  const t = useTranslations();
  const qc = useQueryClient();
  const { toast } = useToast();
  const { label: taxLabel } = useTaxRegime();

  // Owner and admin only (the API refuses staff too). Until the user is read
  // nobody counts as one, so nothing is fetched for a staff session.
  const [role, setRole] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    setRole(getCurrentUser()?.role ?? null);
  }, []);
  const manager = isManager(role);

  const [status, setStatus] = useState<InvoiceStatusFilter>("all");
  const [searchText, setSearchText] = useState("");
  const [q, setQ] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [page, setPage] = useState(1);
  const [dialog, setDialog] = useState<Dialog>(null);

  // The search is sent once the typing stops.
  useEffect(() => {
    const id = setTimeout(() => setQ(searchText.trim()), 350);
    return () => clearTimeout(id);
  }, [searchText]);
  // A new filter starts at the first page.
  useEffect(() => setPage(1), [q, status, dateFrom, dateTo]);

  const filters = { page, q, dateFrom, dateTo, status };
  const list = useQuery({
    queryKey: ["invoices", "list", filters],
    queryFn: async () => invoicePage<Invoice>(await apiClient.listInvoicesPage(invoiceListQuery(filters)), page),
    enabled: manager,
    placeholderData: keepPreviousData,
    refetchInterval: 30_000,
  });
  const tenant = useQuery({
    queryKey: ["auth", "tenant"],
    queryFn: () => apiClient.getTenant(),
    enabled: manager,
    staleTime: 5 * 60 * 1000,
  });
  const timeZone = tenant.data?.timezone || "Europe/Madrid";

  const refresh = () => qc.invalidateQueries({ queryKey: ["invoices"] });
  const resend = useMutation({
    mutationFn: (id: string) => apiClient.resendFiscal(id),
    onSuccess: refresh,
    onError: (err) =>
      toast({
        title: t("invoices.actions.resendError"),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      }),
  });

  async function download(invoice: Invoice, kind: "pdf" | "xml") {
    try {
      const { blob, filename } = await apiClient.downloadInvoiceFile(
        invoice.id,
        kind,
        `factura-${invoice.series}${invoice.number}.${kind}`,
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      toast({
        title: t("invoices.actions.downloadError"),
        description: err instanceof Error ? err.message : undefined,
        variant: "destructive",
      });
    }
  }

  const filtered = !!(q || dateFrom || dateTo || status !== "all");
  const items = list.data?.items ?? [];
  const pages = list.data?.total != null ? Math.max(1, Math.ceil(list.data.total / INVOICE_PAGE_SIZE)) : null;

  if (role !== undefined && !manager) {
    return (
      <div className="mx-auto max-w-6xl">
        <h1 className="text-2xl font-bold text-gray-900">{t("invoices.title")}</h1>
        <p className="mt-4 rounded-lg border border-gray-200 bg-white p-6 text-sm text-gray-600">
          {t("invoices.managersOnly")}
        </p>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">{t("invoices.title")}</h1>
          <p className="mt-1 text-sm text-gray-600">{t("invoices.subtitle")}</p>
        </div>
        {manager && (
          <a
            href="/dashboard/billing/invoices/new"
            className="inline-flex items-center gap-2 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-violet-700"
          >
            {t("invoices.newInvoice")}
          </a>
        )}
      </header>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="space-y-3 border-b border-gray-200 p-4">
          <div className="flex flex-wrap items-end gap-3">
            <label className="relative min-w-[14rem] flex-1">
              <span className="sr-only">{t("invoices.search.label")}</span>
              <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" aria-hidden="true" />
              <input
                type="search"
                value={searchText}
                maxLength={100}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder={t("invoices.search.placeholder")}
                className="w-full rounded-md border border-gray-300 py-2 pl-8 pr-3 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500"
              />
            </label>
            <label className="text-xs text-gray-600">
              <span className="mb-1 block">{t("invoices.search.dateFrom")}</span>
              <input
                type="date"
                value={dateFrom}
                max={dateTo || undefined}
                onChange={(e) => setDateFrom(e.target.value)}
                className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
              />
            </label>
            <label className="text-xs text-gray-600">
              <span className="mb-1 block">{t("invoices.search.dateTo")}</span>
              <input
                type="date"
                value={dateTo}
                min={dateFrom || undefined}
                onChange={(e) => setDateTo(e.target.value)}
                className="rounded-md border border-gray-300 px-2 py-1.5 text-sm"
              />
            </label>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {INVOICE_STATUS_FILTERS.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatus(s)}
                aria-pressed={status === s}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  status === s ? "bg-violet-600 text-white" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                {t(`invoices.filters.${s}`)}
              </button>
            ))}
            {filtered && (
              <button
                type="button"
                onClick={() => {
                  setSearchText("");
                  setQ("");
                  setDateFrom("");
                  setDateTo("");
                  setStatus("all");
                }}
                className="ml-auto text-xs font-medium text-violet-700 hover:underline"
              >
                {t("invoices.search.clear")}
              </button>
            )}
          </div>
        </div>

        {list.isLoading || role === undefined ? (
          <div className="flex items-center justify-center p-12">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : list.isError ? (
          <p className="p-8 text-center text-sm text-red-600">{t("invoices.loadError")}</p>
        ) : items.length === 0 ? (
          <p className="p-8 text-center text-sm text-gray-500">
            {filtered || page > 1 ? t("invoices.emptyFiltered") : t("invoices.empty")}
          </p>
        ) : (
          // The dashboard's <main> hides horizontal overflow: the table scrolls
          // inside its own box on a phone.
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead className="border-b border-gray-200 text-xs uppercase text-gray-500">
                <tr>
                  <th className="px-4 py-3 text-left">
                    {t("invoices.fields.series")}/{t("invoices.fields.number")}
                  </th>
                  <th className="px-4 py-3 text-left">{t("invoices.fields.issueDate")}</th>
                  <th className="px-4 py-3 text-left">{t("invoices.fields.recipientName")}</th>
                  <th className="px-4 py-3 text-right">{t("invoices.fields.total")}</th>
                  <th className="px-4 py-3 text-left">{t("invoices.columns.status")}</th>
                  <th className="px-4 py-3 text-left">{t("invoices.columns.fiscal")}</th>
                  <th className="px-4 py-3 text-right">{t("invoices.columns.actions")}</th>
                </tr>
              </thead>
              <tbody>
                {items.map((inv) => (
                  <InvoiceRow
                    key={inv.id}
                    invoice={inv}
                    timeZone={timeZone}
                    manager={manager}
                    onDownload={(kind) => void download(inv, kind)}
                    onResend={() => resend.mutate(inv.id)}
                    onDialog={(kind) => setDialog({ kind, invoice: inv })}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}

        {(page > 1 || list.data?.hasNext) && (
          <div className="flex items-center justify-between border-t border-gray-200 px-4 py-3 text-sm">
            <button
              type="button"
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1 || list.isFetching}
              className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
              {t("invoices.pagination.previous")}
            </button>
            <span className="text-gray-600">
              {pages
                ? t("invoices.pagination.pageOf", { page: String(page), pages: String(pages) })
                : t("invoices.pagination.page", { page: String(page) })}
            </span>
            <button
              type="button"
              onClick={() => setPage((p) => p + 1)}
              disabled={!list.data?.hasNext || list.isFetching}
              className="inline-flex items-center gap-1 rounded-md border border-gray-300 px-3 py-1.5 text-gray-700 hover:bg-gray-50 disabled:opacity-50"
            >
              {t("invoices.pagination.next")}
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
          </div>
        )}
      </div>

      {dialog?.kind === "email" && <EmailInvoiceDialog invoice={dialog.invoice} onClose={() => setDialog(null)} />}
      {dialog?.kind === "cancel" && (
        <CancelInvoiceDialog invoice={dialog.invoice} onClose={() => setDialog(null)} onDone={refresh} />
      )}
      {dialog?.kind === "rectify" && (
        <RectifyInvoiceDialog
          invoice={dialog.invoice}
          taxLabel={taxLabel}
          onClose={() => setDialog(null)}
          onDone={refresh}
        />
      )}
    </div>
  );
}

function InvoiceRow({
  invoice,
  timeZone,
  manager,
  onDownload,
  onResend,
  onDialog,
}: {
  invoice: Invoice;
  timeZone: string;
  manager: boolean;
  onDownload: (kind: "pdf" | "xml") => void;
  onResend: () => void;
  onDialog: (kind: "email" | "cancel" | "rectify") => void;
}) {
  const t = useTranslations();
  const live = invoice.status !== "cancelled";
  const iconButton = "rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700";
  let date: string;
  try {
    date = new Date(invoice.issueDate).toLocaleDateString("es-ES", { timeZone });
  } catch {
    date = new Date(invoice.issueDate).toLocaleDateString("es-ES");
  }
  return (
    <tr className="border-b border-gray-100 last:border-0">
      <td className="whitespace-nowrap px-4 py-3 font-mono text-xs">
        {invoice.series}
        {invoice.number}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-xs text-gray-700">{date}</td>
      <td className="px-4 py-3">
        <div className="text-sm">{invoice.recipientName}</div>
        {invoice.recipientTaxId && <div className="text-xs text-gray-500">{invoice.recipientTaxId}</div>}
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right font-medium">
        {formatMoney(invoice.totalCents, invoice.currency)}
      </td>
      <td className="px-4 py-3">
        <StatusBadge kind="status" value={invoice.status} />
      </td>
      <td className="px-4 py-3">
        <StatusBadge kind="fiscal" value={invoice.fiscalStatus} />
        {invoice.fiscalError && (
          <div className="mt-1 max-w-xs truncate text-xs text-red-600" title={invoice.fiscalError}>
            {invoice.fiscalError}
          </div>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          <button
            type="button"
            onClick={() => onDownload("pdf")}
            className={iconButton}
            title={t("invoices.actions.downloadPdf")}
            aria-label={t("invoices.actions.downloadPdf")}
          >
            <FileDown className="h-4 w-4" />
          </button>
          {invoice.fiscalXml && (
            <button
              type="button"
              onClick={() => onDownload("xml")}
              className={iconButton}
              title={t("invoices.actions.downloadXml")}
              aria-label={t("invoices.actions.downloadXml")}
            >
              <FileCode className="h-4 w-4" />
            </button>
          )}
          {manager && live && (
            <button
              type="button"
              onClick={() => onDialog("email")}
              className={iconButton}
              title={t("invoices.actions.email")}
              aria-label={t("invoices.actions.email")}
            >
              <Mail className="h-4 w-4" />
            </button>
          )}
          {manager &&
            invoice.fiscalStatus !== "not_required" &&
            invoice.fiscalStatus !== "accepted" && (
              <button
                type="button"
                onClick={onResend}
                className={iconButton}
                title={t("invoices.actions.resend")}
                aria-label={t("invoices.actions.resend")}
              >
                <RefreshCcw className="h-4 w-4" />
              </button>
            )}
          {manager && live && !isRectifying(invoice) && (
            <button
              type="button"
              onClick={() => onDialog("rectify")}
              className={iconButton}
              title={t("invoices.actions.rectify")}
              aria-label={t("invoices.actions.rectify")}
            >
              <FileMinus className="h-4 w-4" />
            </button>
          )}
          {manager && live && (
            <button
              type="button"
              onClick={() => onDialog("cancel")}
              className="rounded-md p-1.5 text-red-500 hover:bg-red-50 hover:text-red-700"
              title={t("invoices.actions.cancel")}
              aria-label={t("invoices.actions.cancel")}
            >
              <Ban className="h-4 w-4" />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function StatusBadge({ kind, value }: { kind: "status" | "fiscal"; value: string }) {
  const t = useTranslations();
  const colorMap: Record<string, string> = {
    draft: "bg-gray-100 text-gray-700",
    issued: "bg-blue-100 text-blue-700",
    paid: "bg-blue-100 text-blue-700",
    cancelled: "bg-red-100 text-red-700",
    refunded: "bg-blue-100 text-blue-700",
    not_required: "bg-gray-100 text-gray-600",
    pending: "bg-yellow-100 text-yellow-700",
    accepted: "bg-green-100 text-green-700",
    rejected: "bg-red-100 text-red-700",
    error: "bg-red-100 text-red-700",
  };
  const group = kind === "status" ? "status" : "fiscalStatus";
  return (
    <span
      className={`inline-flex items-center whitespace-nowrap rounded-full px-2 py-0.5 text-[10px] font-medium ${
        colorMap[value] ?? "bg-gray-100 text-gray-700"
      }`}
    >
      {t(`invoices.${group}.${value}`)}
    </span>
  );
}
