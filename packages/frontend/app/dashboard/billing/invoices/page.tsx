"use client";

import { useState } from "react";
import {
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import apiClient, { Invoice } from "@/lib/api";
import { Loader2, FileDown, FileCode, RefreshCcw, Ban } from "lucide-react";
import { useTranslations } from "@/lib/use-translation";

function formatMoney(cents: number, currency = "EUR") {
  return (cents / 100).toLocaleString("es-ES", {
    style: "currency",
    currency,
  });
}

export default function InvoicesPage() {
  const t = useTranslations();
  const qc = useQueryClient();
  const [statusFilter, setStatusFilter] = useState<string>("all");

  const list = useQuery<Invoice[]>({
    queryKey: ["invoices", { status: statusFilter }],
    queryFn: () =>
      apiClient.listInvoices(
        statusFilter !== "all" ? { status: statusFilter } : undefined,
      ),
    refetchInterval: 30_000,
  });

  const resend = useMutation({
    mutationFn: (id: string) => apiClient.resendFiscal(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invoices"] }),
  });
  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      apiClient.cancelInvoice(id, reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["invoices"] }),
  });

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">
            {t("invoices.title")}
          </h1>
          <p className="mt-1 text-sm text-gray-600">
            {t("invoices.subtitle")}
          </p>
        </div>
        <a
          href="/dashboard/billing/invoices/new"
          className="inline-flex items-center gap-2 rounded-md bg-violet-600 px-4 py-2 text-sm font-medium text-white shadow-sm hover:bg-violet-700"
        >
          {t("invoices.newInvoice")}
        </a>
      </header>

      <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
        <div className="border-b border-gray-200 p-4">
          <div className="flex flex-wrap gap-2">
            {(
              [
                "all",
                "draft",
                "issued",
                "paid",
                "cancelled",
                "refunded",
              ] as const
            ).map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => setStatusFilter(s)}
                className={`rounded-md px-3 py-1.5 text-xs font-medium transition-colors ${
                  statusFilter === s
                    ? "bg-violet-600 text-white"
                    : "bg-gray-100 text-gray-700 hover:bg-gray-200"
                }`}
              >
                {t(`invoices.filters.${s}`)}
              </button>
            ))}
          </div>
        </div>

        {list.isLoading ? (
          <div className="flex items-center justify-center p-12">
            <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
          </div>
        ) : !list.data || list.data.length === 0 ? (
          <p className="p-8 text-center text-sm text-gray-500">
            {t("invoices.empty")}
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-b border-gray-200 text-xs uppercase text-gray-500">
              <tr>
                <th className="px-4 py-3 text-left">{t("invoices.fields.series")}/{t("invoices.fields.number")}</th>
                <th className="px-4 py-3 text-left">{t("invoices.fields.issueDate")}</th>
                <th className="px-4 py-3 text-left">{t("invoices.fields.recipientName")}</th>
                <th className="px-4 py-3 text-right">{t("invoices.fields.total")}</th>
                <th className="px-4 py-3 text-left">Estado</th>
                <th className="px-4 py-3 text-left">Fiscal</th>
                <th className="px-4 py-3 text-right">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {list.data.map((inv) => (
                <InvoiceRow
                  key={inv.id}
                  invoice={inv}
                  onResend={() => resend.mutate(inv.id)}
                  onCancel={() => {
                    const reason = window.prompt("Motivo de anulacion");
                    if (reason) cancel.mutate({ id: inv.id, reason });
                  }}
                />
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

function InvoiceRow({
  invoice,
  onResend,
  onCancel,
}: {
  invoice: Invoice;
  onResend: () => void;
  onCancel: () => void;
}) {
  const t = useTranslations();
  return (
    <tr className="border-b border-gray-100 last:border-0">
      <td className="px-4 py-3 font-mono text-xs">
        {invoice.series}
        {invoice.number}
      </td>
      <td className="px-4 py-3 text-xs text-gray-700">
        {new Date(invoice.issueDate).toLocaleDateString("es-ES")}
      </td>
      <td className="px-4 py-3">
        <div className="text-sm">{invoice.recipientName}</div>
        {invoice.recipientTaxId && (
          <div className="text-xs text-gray-500">{invoice.recipientTaxId}</div>
        )}
      </td>
      <td className="px-4 py-3 text-right font-medium">
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
          <a
            href={apiClient.getInvoicePdfUrl(invoice.id)}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
            title={t("invoices.actions.downloadPdf")}
          >
            <FileDown className="h-4 w-4" />
          </a>
          {invoice.fiscalXml && (
            <a
              href={apiClient.getInvoiceXmlUrl(invoice.id)}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
              title={t("invoices.actions.downloadXml")}
            >
              <FileCode className="h-4 w-4" />
            </a>
          )}
          {invoice.fiscalStatus !== "not_required" &&
            invoice.fiscalStatus !== "accepted" && (
              <button
                type="button"
                onClick={onResend}
                className="rounded-md p-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-700"
                title={t("invoices.actions.resend")}
              >
                <RefreshCcw className="h-4 w-4" />
              </button>
            )}
          {invoice.status !== "cancelled" && (
            <button
              type="button"
              onClick={onCancel}
              className="rounded-md p-1.5 text-red-500 hover:bg-red-50 hover:text-red-700"
              title={t("invoices.actions.cancel")}
            >
              <Ban className="h-4 w-4" />
            </button>
          )}
        </div>
      </td>
    </tr>
  );
}

function StatusBadge({
  kind,
  value,
}: {
  kind: "status" | "fiscal";
  value: string;
}) {
  const t = useTranslations();
  const colorMap: Record<string, string> = {
    draft: "bg-gray-100 text-gray-700",
    issued: "bg-blue-100 text-blue-700",
    paid: "bg-green-100 text-green-700",
    cancelled: "bg-red-100 text-red-700",
    refunded: "bg-orange-100 text-orange-700",
    not_required: "bg-gray-100 text-gray-600",
    pending: "bg-yellow-100 text-yellow-700",
    accepted: "bg-green-100 text-green-700",
    rejected: "bg-red-100 text-red-700",
    error: "bg-red-100 text-red-700",
  };
  const key = `${kind === "status" ? "filters" : "fiscalStatus"}.${value}`;
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${
        colorMap[value] ?? "bg-gray-100 text-gray-700"
      }`}
    >
      {t(key)}
    </span>
  );
}