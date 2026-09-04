"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertCircle, Loader2, Plus, Trash2 } from "lucide-react";
import apiClient, { Client } from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";

interface InvoiceLineForm {
  id: string;
  description: string;
  quantity: string;
  unitPrice: string;
  discountPct: string;
  taxRate: string;
}

const emptyLine = (id: string): InvoiceLineForm => ({
  id,
  description: "",
  quantity: "1",
  unitPrice: "0.00",
  discountPct: "0",
  taxRate: "21",
});

const inputClassName =
  "w-full rounded-lg border border-gray-300 px-3 py-2 text-sm text-gray-900 outline-none transition focus:border-violet-500 focus:ring-2 focus:ring-violet-100";

function parseNumber(value: string) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function calculateLine(line: InvoiceLineForm) {
  const quantity = parseNumber(line.quantity);
  const unitPriceCents = Math.round(parseNumber(line.unitPrice) * 100);
  const discountPct = parseNumber(line.discountPct);
  const taxRate = parseNumber(line.taxRate);
  const subtotalCents = Math.round(
    quantity * unitPriceCents * (1 - discountPct / 100),
  );
  const taxCents = Math.round(subtotalCents * (taxRate / 100));

  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

function formatMoney(cents: number) {
  return (cents / 100).toLocaleString("es-ES", {
    style: "currency",
    currency: "EUR",
  });
}

export function InvoiceForm() {
  const t = useTranslations();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [series, setSeries] = useState("");
  const [issueDate, setIssueDate] = useState(
    () => new Date().toISOString().slice(0, 10),
  );
  const [recipientId, setRecipientId] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [recipientTaxId, setRecipientTaxId] = useState("");
  const [notes, setNotes] = useState("");
  const [lines, setLines] = useState<InvoiceLineForm[]>([emptyLine("line-1")]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clients = useQuery<Client[]>({
    queryKey: ["clients"],
    queryFn: () => apiClient.getClients(),
  });

  const totals = useMemo(
    () =>
      lines.reduce(
        (sum, line) => {
          const current = calculateLine(line);
          return {
            subtotalCents: sum.subtotalCents + current.subtotalCents,
            taxCents: sum.taxCents + current.taxCents,
            totalCents: sum.totalCents + current.totalCents,
          };
        },
        { subtotalCents: 0, taxCents: 0, totalCents: 0 },
      ),
    [lines],
  );

  const selectClient = (id: string) => {
    setRecipientId(id);
    const client = clients.data?.find((item) => item.id === id);
    if (client) {
      setRecipientName(`${client.firstName} ${client.lastName}`.trim());
      setRecipientTaxId(client.taxId ?? "");
    }
  };

  const updateLine = (
    id: string,
    field: keyof Omit<InvoiceLineForm, "id">,
    value: string,
  ) => {
    setLines((current) =>
      current.map((line) =>
        line.id === id ? { ...line, [field]: value } : line,
      ),
    );
  };

  const addLine = () => {
    setLines((current) => [
      ...current,
      emptyLine(`line-${Date.now()}-${current.length}`),
    ]);
  };

  const removeLine = (id: string) => {
    setLines((current) => current.filter((line) => line.id !== id));
  };

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);

    if (!recipientName.trim()) {
      setError(t("invoices.errors.recipientRequired"));
      return;
    }

    const validLines =
      lines.length > 0 &&
      lines.every((line) => {
        const quantity = parseNumber(line.quantity);
        const unitPrice = parseNumber(line.unitPrice);
        const discountPct = parseNumber(line.discountPct);
        const taxRate = parseNumber(line.taxRate);
        return (
          line.description.trim().length > 0 &&
          quantity > 0 &&
          unitPrice >= 0 &&
          discountPct >= 0 &&
          discountPct <= 100 &&
          taxRate >= 0
        );
      });

    if (!validLines) {
      setError(t("invoices.errors.invalidLines"));
      return;
    }

    setIsSubmitting(true);
    try {
      await apiClient.createInvoice({
        series: series.trim() || undefined,
        issueDate: issueDate || undefined,
        recipientType: "client",
        recipientId: recipientId || undefined,
        recipientName: recipientName.trim(),
        recipientTaxId: recipientTaxId.trim().toUpperCase() || undefined,
        lines: lines.map((line) => ({
          description: line.description.trim(),
          quantity: parseNumber(line.quantity),
          unitPriceCents: Math.round(parseNumber(line.unitPrice) * 100),
          discountPct: parseNumber(line.discountPct),
          taxRate: parseNumber(line.taxRate),
        })),
        notes: notes.trim() || undefined,
      });
      await queryClient.invalidateQueries({ queryKey: ["invoices"] });
      router.push("/dashboard/billing/invoices");
    } catch (caughtError) {
      setError(
        caughtError instanceof Error
          ? caughtError.message
          : t("invoices.errors.createFailed"),
      );
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="flex items-start gap-3 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">
          {t("invoices.form.invoiceDetails")}
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="series" className="mb-1 block text-sm font-medium text-gray-700">
              {t("invoices.fields.series")}
            </label>
            <input
              id="series"
              value={series}
              onChange={(event) => setSeries(event.target.value)}
              className={inputClassName}
              placeholder={t("invoices.form.defaultSeries")}
            />
          </div>
          <div>
            <label htmlFor="issueDate" className="mb-1 block text-sm font-medium text-gray-700">
              {t("invoices.fields.issueDate")}
            </label>
            <input
              id="issueDate"
              type="date"
              value={issueDate}
              onChange={(event) => setIssueDate(event.target.value)}
              className={inputClassName}
            />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <h2 className="mb-4 text-lg font-semibold text-gray-900">
          {t("invoices.form.recipientDetails")}
        </h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label htmlFor="client" className="mb-1 block text-sm font-medium text-gray-700">
              {t("invoices.form.registeredClient")}
            </label>
            <select
              id="client"
              value={recipientId}
              onChange={(event) => selectClient(event.target.value)}
              disabled={clients.isLoading}
              className={inputClassName}
            >
              <option value="">
                {clients.isLoading
                  ? t("invoices.form.loadingClients")
                  : t("invoices.form.manualRecipient")}
              </option>
              {clients.data?.map((client) => (
                <option key={client.id} value={client.id}>
                  {client.firstName} {client.lastName}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor="recipientName" className="mb-1 block text-sm font-medium text-gray-700">
              {t("invoices.fields.recipientName")} *
            </label>
            <input
              id="recipientName"
              required
              value={recipientName}
              onChange={(event) => setRecipientName(event.target.value)}
              className={inputClassName}
            />
          </div>
          <div>
            <label htmlFor="recipientTaxId" className="mb-1 block text-sm font-medium text-gray-700">
              {t("invoices.fields.recipientTaxId")}
            </label>
            <input
              id="recipientTaxId"
              value={recipientTaxId}
              onChange={(event) => setRecipientTaxId(event.target.value.toUpperCase())}
              className={`${inputClassName} uppercase`}
            />
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <div className="mb-4 flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold text-gray-900">
            {t("invoices.fields.lines")}
          </h2>
          <button
            type="button"
            onClick={addLine}
            className="inline-flex items-center gap-2 rounded-lg border border-violet-200 px-3 py-2 text-sm font-medium text-violet-700 hover:bg-violet-50"
          >
            <Plus className="h-4 w-4" />
            {t("invoices.fields.addLine")}
          </button>
        </div>

        <div className="space-y-4">
          {lines.map((line, index) => (
            <div key={line.id} className="rounded-lg border border-gray-200 p-4">
              <div className="mb-3 flex items-center justify-between">
                <span className="text-sm font-medium text-gray-700">
                  {t("invoices.form.lineNumber", { number: index + 1 })}
                </span>
                <button
                  type="button"
                  onClick={() => removeLine(line.id)}
                  disabled={lines.length === 1}
                  className="inline-flex items-center gap-1 text-sm text-red-600 hover:text-red-700 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <Trash2 className="h-4 w-4" />
                  {t("invoices.fields.removeLine")}
                </button>
              </div>
              <div className="grid grid-cols-1 gap-4 md:grid-cols-12">
                <div className="md:col-span-4">
                  <label htmlFor={`${line.id}-description`} className="mb-1 block text-xs font-medium text-gray-600">
                    {t("invoices.fields.description")} *
                  </label>
                  <input
                    id={`${line.id}-description`}
                    required
                    value={line.description}
                    onChange={(event) => updateLine(line.id, "description", event.target.value)}
                    className={inputClassName}
                  />
                </div>
                <div className="md:col-span-2">
                  <label htmlFor={`${line.id}-quantity`} className="mb-1 block text-xs font-medium text-gray-600">
                    {t("invoices.fields.quantity")}
                  </label>
                  <input
                    id={`${line.id}-quantity`}
                    type="number"
                    min="0.01"
                    step="0.01"
                    required
                    value={line.quantity}
                    onChange={(event) => updateLine(line.id, "quantity", event.target.value)}
                    className={inputClassName}
                  />
                </div>
                <div className="md:col-span-2">
                  <label htmlFor={`${line.id}-unitPrice`} className="mb-1 block text-xs font-medium text-gray-600">
                    {t("invoices.fields.unitPrice")}
                  </label>
                  <input
                    id={`${line.id}-unitPrice`}
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    value={line.unitPrice}
                    onChange={(event) => updateLine(line.id, "unitPrice", event.target.value)}
                    className={inputClassName}
                  />
                </div>
                <div className="md:col-span-2">
                  <label htmlFor={`${line.id}-discountPct`} className="mb-1 block text-xs font-medium text-gray-600">
                    {t("invoices.fields.discountPct")}
                  </label>
                  <input
                    id={`${line.id}-discountPct`}
                    type="number"
                    min="0"
                    max="100"
                    step="0.01"
                    value={line.discountPct}
                    onChange={(event) => updateLine(line.id, "discountPct", event.target.value)}
                    className={inputClassName}
                  />
                </div>
                <div className="md:col-span-2">
                  <label htmlFor={`${line.id}-taxRate`} className="mb-1 block text-xs font-medium text-gray-600">
                    {t("invoices.fields.taxRate")}
                  </label>
                  <input
                    id={`${line.id}-taxRate`}
                    type="number"
                    min="0"
                    step="0.01"
                    required
                    value={line.taxRate}
                    onChange={(event) => updateLine(line.id, "taxRate", event.target.value)}
                    className={inputClassName}
                  />
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="ml-auto mt-6 max-w-xs space-y-2 border-t border-gray-200 pt-4 text-sm">
          <div className="flex justify-between text-gray-600">
            <span>{t("invoices.fields.subtotal")}</span>
            <span>{formatMoney(totals.subtotalCents)}</span>
          </div>
          <div className="flex justify-between text-gray-600">
            <span>{t("invoices.fields.tax")}</span>
            <span>{formatMoney(totals.taxCents)}</span>
          </div>
          <div className="flex justify-between text-base font-semibold text-gray-900">
            <span>{t("invoices.fields.total")}</span>
            <span>{formatMoney(totals.totalCents)}</span>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-gray-200 bg-white p-6 shadow-sm">
        <label htmlFor="notes" className="mb-1 block text-sm font-medium text-gray-700">
          {t("invoices.fields.notes")}
        </label>
        <textarea
          id="notes"
          rows={4}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          className={`${inputClassName} resize-y`}
        />
      </section>

      <div className="flex flex-col-reverse justify-end gap-3 sm:flex-row">
        <Link
          href="/dashboard/billing/invoices"
          className="inline-flex items-center justify-center rounded-lg border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
        >
          {t("invoices.form.cancel")}
        </Link>
        <button
          type="submit"
          disabled={isSubmitting}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-violet-600 px-5 py-2 text-sm font-medium text-white shadow-sm hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
          {isSubmitting
            ? t("invoices.form.creating")
            : t("invoices.actions.create")}
        </button>
      </div>
    </form>
  );
}
