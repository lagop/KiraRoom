"use client";

import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import apiClient, { Invoice } from "@/lib/api";
import { useTranslations } from "@/lib/use-translation";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";
import { parseEuros, rectifyBody, RectifyMode } from "@/lib/invoice-list";

const inputClass =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-violet-500 focus:outline-none focus:ring-1 focus:ring-violet-500";

function invoiceNumber(invoice: Invoice) {
  return `${invoice.series}${invoice.number}`;
}

function errorMessage(err: unknown): string | undefined {
  return err instanceof Error ? err.message : undefined;
}

/** A modal panel in the ConfirmDialog style, for the dialogs with a form. */
function Modal({
  title,
  onClose,
  children,
  footer,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer: React.ReactNode;
}) {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={title}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/40 p-4"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div className="flex max-h-[90vh] w-full max-w-lg flex-col rounded-lg border border-gray-200 bg-white shadow-xl">
        <h2 className="border-b border-gray-100 px-6 py-4 text-base font-semibold text-gray-900">{title}</h2>
        <div className="flex-1 space-y-4 overflow-y-auto px-6 py-4 text-sm text-gray-700">{children}</div>
        <div className="flex justify-end gap-2 border-t border-gray-100 px-6 py-3">{footer}</div>
      </div>
    </div>
  );
}

const secondaryButton =
  "rounded-md border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50";
const primaryButton =
  "inline-flex items-center gap-1.5 rounded-md bg-violet-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:opacity-50";

// ---------------------------------------------------------------- email

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function EmailInvoiceDialog({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const t = useTranslations();
  const { toast } = useToast();
  const [to, setTo] = useState("");
  const [error, setError] = useState<string | null>(null);
  const client = useQuery({
    queryKey: ["clients", invoice.recipientId],
    queryFn: () => apiClient.getClient(invoice.recipientId as string),
    enabled: !!invoice.recipientId && invoice.recipientType === "client",
    staleTime: 60_000,
    retry: false,
  });
  const clientEmail = client.data?.email?.trim() || null;

  const send = useMutation({
    mutationFn: () => apiClient.emailInvoice(invoice.id, to.trim() || undefined),
    onSuccess: (res) => {
      toast({ title: t("invoices.emailDialog.sent"), description: t("invoices.emailDialog.sentTo", { email: res.to }) });
      onClose();
    },
    onError: (err) => {
      toast({ title: t("invoices.emailDialog.error"), description: errorMessage(err), variant: "destructive" });
    },
  });

  function submit() {
    const typed = to.trim();
    if (typed && !EMAIL_RE.test(typed)) {
      setError(t("invoices.emailDialog.invalid"));
      return;
    }
    setError(null);
    send.mutate();
  }

  return (
    <Modal
      title={t("invoices.emailDialog.title", { number: invoiceNumber(invoice) })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose} disabled={send.isPending}>
            {t("invoices.rectifyDialog.cancel")}
          </button>
          <button type="button" className={primaryButton} onClick={submit} disabled={send.isPending}>
            {send.isPending && <Loader2 className="h-4 w-4 animate-spin" />}
            {send.isPending ? t("invoices.emailDialog.sending") : t("invoices.emailDialog.send")}
          </button>
        </>
      }
    >
      <p>{t("invoices.emailDialog.description")}</p>
      <p className="text-gray-600">
        {clientEmail
          ? t("invoices.emailDialog.clientEmail", { email: clientEmail })
          : client.isSuccess || !invoice.recipientId
            ? t("invoices.emailDialog.noClientEmail")
            : t("invoices.emailDialog.clientEmailUnknown")}
      </p>
      <div>
        <label htmlFor="invoice-email-to" className="mb-1 block font-medium text-gray-700">
          {t("invoices.emailDialog.toLabel")}
        </label>
        <input
          id="invoice-email-to"
          type="email"
          autoComplete="email"
          className={inputClass}
          placeholder={t("invoices.emailDialog.toPlaceholder")}
          value={to}
          maxLength={254}
          onChange={(e) => setTo(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- cancel

export function CancelInvoiceDialog({
  invoice,
  onClose,
  onDone,
}: {
  invoice: Invoice;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations();
  const { toast } = useToast();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const cancel = useMutation({
    mutationFn: () => apiClient.cancelInvoice(invoice.id, reason.trim()),
    onSuccess: () => {
      toast({ title: t("invoices.cancelDialog.done") });
      onDone();
      onClose();
    },
    onError: (err) => {
      toast({ title: t("invoices.cancelDialog.error"), description: errorMessage(err), variant: "destructive" });
    },
  });

  return (
    <ConfirmDialog
      open
      title={t("invoices.cancelDialog.title", { number: invoiceNumber(invoice) })}
      description={
        <div className="space-y-3">
          <p>{t("invoices.cancelDialog.explanation")}</p>
          <div>
            <label htmlFor="invoice-cancel-reason" className="mb-1 block font-medium text-gray-700">
              {t("invoices.cancelDialog.reasonLabel")}
            </label>
            <textarea
              id="invoice-cancel-reason"
              rows={2}
              maxLength={500}
              className={inputClass}
              placeholder={t("invoices.cancelDialog.reasonPlaceholder")}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
          </div>
        </div>
      }
      confirmLabel={t("invoices.cancelDialog.confirm")}
      cancelLabel={t("invoices.rectifyDialog.cancel")}
      destructive
      loading={cancel.isPending}
      onCancel={onClose}
      onConfirm={() => {
        if (!reason.trim()) {
          setError(t("invoices.cancelDialog.reasonRequired"));
          return;
        }
        setError(null);
        cancel.mutate();
      }}
    />
  );
}

// ---------------------------------------------------------------- rectify

function formatCents(cents: number, currency = "EUR") {
  return (cents / 100).toLocaleString("es-ES", { style: "currency", currency });
}

export function RectifyInvoiceDialog({
  invoice,
  taxLabel,
  onClose,
  onDone,
}: {
  invoice: Invoice;
  taxLabel: string;
  onClose: () => void;
  onDone: () => void;
}) {
  const t = useTranslations();
  const { toast } = useToast();
  const [mode, setMode] = useState<RectifyMode>("full");
  const [reason, setReason] = useState("");
  const [units, setUnits] = useState<Record<string, string>>({});
  const [amount, setAmount] = useState("");
  const [concept, setConcept] = useState("");
  // Prisma decimals arrive as strings: numbers here.
  const lines = useMemo(
    () =>
      (invoice.lines ?? [])
        .filter((l) => l.id && Number(l.quantity) > 0)
        .map((l) => ({ ...l, id: l.id as string, quantity: Number(l.quantity), taxRate: Number(l.taxRate) })),
    [invoice.lines],
  );
  const rates = useMemo(() => {
    const fromBreakdown = (invoice.taxBreakdown ?? []).map((b) => Number(b.rate));
    const all = fromBreakdown.length ? fromBreakdown : lines.map((l) => l.taxRate);
    return Array.from(new Set(all)).sort((a, b) => b - a);
  }, [invoice.taxBreakdown, lines]);
  const [taxRate, setTaxRate] = useState<number>(() => rates[0] ?? 0);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const built = rectifyBody({
    mode,
    reason,
    lines: lines.map((l) => ({ originalLineId: l.id, quantity: Number((units[l.id] ?? "").replace(",", ".")) || 0 })),
    amountCents: parseEuros(amount),
    taxRate,
    description: concept,
  });

  const rectify = useMutation({
    mutationFn: () => {
      if ("error" in built) throw new Error(built.error);
      return apiClient.rectifyInvoice(invoice.id, built.body);
    },
    onSuccess: () => {
      toast({ title: t("invoices.rectifyDialog.done") });
      onDone();
      onClose();
    },
    onError: (err) => {
      setConfirming(false);
      toast({ title: t("invoices.rectifyDialog.error"), description: errorMessage(err), variant: "destructive" });
    },
  });

  function next() {
    if ("error" in built) {
      setError(built.error);
      return;
    }
    const over = lines.find((l) => Number((units[l.id] ?? "").replace(",", ".")) > l.quantity);
    if (mode === "lines" && over) {
      setError(`${over.description}: ${t("invoices.rectifyDialog.ofQuantity", { quantity: String(over.quantity) })}`);
      return;
    }
    setError(null);
    setConfirming(true);
  }

  const modes: Array<{ id: RectifyMode; label: string; hint: string }> = [
    { id: "full", label: t("invoices.rectifyDialog.modeFull"), hint: t("invoices.rectifyDialog.modeFullHint") },
    ...(lines.length
      ? [{ id: "lines" as const, label: t("invoices.rectifyDialog.modeLines"), hint: t("invoices.rectifyDialog.modeLinesHint") }]
      : []),
    { id: "amount", label: t("invoices.rectifyDialog.modeAmount"), hint: t("invoices.rectifyDialog.modeAmountHint") },
  ];

  if (confirming) {
    return (
      <ConfirmDialog
        open
        title={t("invoices.rectifyDialog.confirmTitle")}
        description={t("invoices.rectifyDialog.confirmDescription", { number: invoiceNumber(invoice) })}
        confirmLabel={t("invoices.rectifyDialog.confirm")}
        cancelLabel={t("invoices.rectifyDialog.cancel")}
        loading={rectify.isPending}
        onCancel={() => setConfirming(false)}
        onConfirm={() => rectify.mutate()}
      />
    );
  }

  return (
    <Modal
      title={t("invoices.rectifyDialog.title", { number: invoiceNumber(invoice) })}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={secondaryButton} onClick={onClose}>
            {t("invoices.rectifyDialog.cancel")}
          </button>
          <button type="button" className={primaryButton} onClick={next}>
            {t("invoices.rectifyDialog.continue")}
          </button>
        </>
      }
    >
      <p className="text-gray-600">{t("invoices.rectifyDialog.intro")}</p>

      <fieldset className="space-y-2">
        {modes.map((m) => (
          <label
            key={m.id}
            className={`flex cursor-pointer items-start gap-3 rounded-md border p-3 ${
              mode === m.id ? "border-violet-500 bg-violet-50" : "border-gray-200"
            }`}
          >
            <input
              type="radio"
              name="rectify-mode"
              className="mt-0.5"
              checked={mode === m.id}
              onChange={() => setMode(m.id)}
            />
            <span>
              <span className="block font-medium text-gray-900">{m.label}</span>
              <span className="block text-xs text-gray-500">{m.hint}</span>
            </span>
          </label>
        ))}
      </fieldset>

      {mode === "lines" && (
        <div className="space-y-2">
          {lines.map((l) => (
            <div key={l.id} className="flex flex-wrap items-center gap-2 rounded-md border border-gray-200 p-2">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-gray-900">{l.description}</div>
                <div className="text-xs text-gray-500">
                  {formatCents(l.totalCents ?? 0, invoice.currency)} · {l.taxRate} % {taxLabel}
                </div>
              </div>
              <label className="flex items-center gap-1 text-xs text-gray-600">
                <span className="sr-only">{t("invoices.rectifyDialog.unitsToReturn")}</span>
                <input
                  type="number"
                  min={0}
                  max={l.quantity}
                  step="any"
                  inputMode="decimal"
                  aria-label={`${t("invoices.rectifyDialog.unitsToReturn")}: ${l.description}`}
                  className="w-20 rounded-md border border-gray-300 px-2 py-1 text-right text-sm"
                  value={units[l.id] ?? ""}
                  placeholder="0"
                  onChange={(e) => setUnits((u) => ({ ...u, [l.id]: e.target.value }))}
                />
                {t("invoices.rectifyDialog.ofQuantity", { quantity: String(l.quantity) })}
              </label>
            </div>
          ))}
        </div>
      )}

      {mode === "amount" && (
        <div className="grid gap-3 sm:grid-cols-2">
          <div>
            <label htmlFor="rectify-amount" className="mb-1 block font-medium text-gray-700">
              {t("invoices.rectifyDialog.amount", { tax: taxLabel })}
            </label>
            <input
              id="rectify-amount"
              inputMode="decimal"
              className={inputClass}
              placeholder="0,00"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="rectify-rate" className="mb-1 block font-medium text-gray-700">
              {t("invoices.rectifyDialog.taxRate", { tax: taxLabel })}
            </label>
            <select
              id="rectify-rate"
              className={inputClass}
              value={String(taxRate)}
              onChange={(e) => setTaxRate(Number(e.target.value))}
            >
              {(rates.length ? rates : [0]).map((r) => (
                <option key={r} value={String(r)}>
                  {r} %
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label htmlFor="rectify-concept" className="mb-1 block font-medium text-gray-700">
              {t("invoices.rectifyDialog.concept")}
            </label>
            <input
              id="rectify-concept"
              className={inputClass}
              maxLength={200}
              placeholder={t("invoices.rectifyDialog.conceptPlaceholder")}
              value={concept}
              onChange={(e) => setConcept(e.target.value)}
            />
          </div>
        </div>
      )}

      <div>
        <label htmlFor="rectify-reason" className="mb-1 block font-medium text-gray-700">
          {t("invoices.rectifyDialog.reason")}
        </label>
        <textarea
          id="rectify-reason"
          rows={2}
          maxLength={500}
          className={inputClass}
          placeholder={t("invoices.rectifyDialog.reasonPlaceholder")}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </Modal>
  );
}
