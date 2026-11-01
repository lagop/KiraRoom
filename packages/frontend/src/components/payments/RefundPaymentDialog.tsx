"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import apiClient, { type Payment, type PaymentRefundResult } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";
import {
  formatEuros,
  methodLabel,
  parseEurosToCents,
  pickedLines,
  refundableCents,
  type RefundableSaleLine,
} from "@/lib/payments-format";

type RefundablePayment = Pick<Payment, "id" | "amount" | "status" | "method" | "refundedAmount" | "client"> &
  Partial<Pick<Payment, "metadata" | "appointmentId" | "type">>;

/** A payment the till took for a sale of its own (not a visit's, not a gift card): its lines can be picked. */
function tillSaleOf(payment: RefundablePayment | null): boolean {
  const saleId = payment?.metadata?.posSaleId;
  return typeof saleId === "string" && !!saleId && !payment?.appointmentId && payment?.type !== "gift_card";
}

const centsToInput = (cents: number) => (cents / 100).toFixed(2).replace(".", ",");

export interface RefundPaymentDialogProps {
  /** The payment to refund; null closes the dialog. */
  payment: RefundablePayment | null;
  onClose: () => void;
  /** After a refund was recorded: reload the list. */
  onRefunded?: (result: PaymentRefundResult) => void;
}

/**
 * Gives back all or part of a charge taken at the salon (cash, card
 * terminal, transfer or wallet) -- POST /payments/:id/refund, owner/admin.
 * The amount starts at everything that can still be refunded; a reason is
 * required. Nothing is sent to Stripe: these are charges taken in the salon,
 * the money is given back there.
 *
 * A payment of a till sale lists the sale's lines: the units picked are
 * given back (products return to stock) and the amount follows what they
 * are worth. An amount with no lines picked does not change the stock.
 *
 * When the visit already has its invoice issued, the invoice is not edited:
 * the dialog then says so and offers Facturas, where the rectificativa is
 * issued.
 */
export function RefundPaymentDialog({ payment, onClose, onRefunded }: RefundPaymentDialogProps) {
  const router = useRouter();
  const { toast } = useToast();
  const [amount, setAmount] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);
  const [invoice, setInvoice] = React.useState<PaymentRefundResult["invoice"]>(null);

  const [lines, setLines] = React.useState<RefundableSaleLine[]>([]);
  const [picks, setPicks] = React.useState<Record<string, number>>({});
  const [linesLoading, setLinesLoading] = React.useState(false);

  const left = payment ? refundableCents(payment) : 0;
  const picked = pickedLines(lines, picks);
  const pickedMax = Math.min(left, picked.valueCents);

  React.useEffect(() => {
    if (!payment) return;
    setAmount(centsToInput(refundableCents(payment)));
    setReason("");
    setError(null);
    setLines([]);
    setPicks({});
    if (!tillSaleOf(payment)) return;
    let live = true;
    setLinesLoading(true);
    apiClient
      .getPaymentRefundLines(payment.id)
      .then((r) => {
        if (live) setLines(r.lines.filter((l) => l.refundableQuantity > 0));
      })
      .catch(() => {
        // The amount alone still works: the lines are a help, not a requirement.
        if (live) setLines([]);
      })
      .finally(() => {
        if (live) setLinesLoading(false);
      });
    return () => {
      live = false;
    };
  }, [payment]);

  const pick = (line: RefundableSaleLine, quantity: number) => {
    const next = { ...picks, [line.id]: Math.max(0, Math.min(line.refundableQuantity, quantity)) };
    setPicks(next);
    const chosen = pickedLines(lines, next);
    // The amount follows the lines picked; none picked: back to all that is left.
    setAmount(centsToInput(chosen.lines.length ? Math.min(left, chosen.valueCents) : left));
  };

  const submit = async () => {
    if (!payment) return;
    const cents = parseEurosToCents(amount);
    if (cents === null) {
      setError("Escribe un importe en euros mayor que 0, por ejemplo 12,50.");
      return;
    }
    if (cents > left) {
      setError(`Como máximo puedes devolver ${formatEuros(left)}.`);
      return;
    }
    const withLines = picked.lines.length > 0;
    if (withLines && cents > pickedMax) {
      setError(`Por las líneas elegidas puedes devolver como máximo ${formatEuros(pickedMax)}.`);
      return;
    }
    if (!reason.trim()) {
      setError("Indica el motivo de la devolución.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await apiClient.refundPayment(payment.id, {
        // All that is left (or all the lines are worth): let the server work it out from its own figures.
        ...(cents === (withLines ? pickedMax : left) ? {} : { amount: cents }),
        ...(withLines ? { lines: picked.lines } : {}),
        reason: reason.trim(),
      });
      const restocked = (result.restocked ?? []).reduce((s, r) => s + r.quantity, 0);
      toast({
        title: cents === left ? "Cobro devuelto" : "Devolución registrada",
        description:
          `${formatEuros(cents)} devueltos${payment.method === "wallet" ? " a la cartera de la clienta" : ""}.` +
          (restocked ? ` ${restocked === 1 ? "1 producto vuelve" : `${restocked} productos vuelven`} al stock.` : ""),
      });
      onRefunded?.(result);
      onClose();
      if (result.rectificationNeeded && result.invoice) setInvoice(result.invoice);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se ha podido registrar la devolución.");
    } finally {
      setSaving(false);
    }
  };

  const client = payment?.client ? `${payment.client.firstName} ${payment.client.lastName}`.trim() : null;

  return (
    <>
      <ConfirmDialog
        open={!!payment}
        title={payment ? `Devolver un cobro de ${formatEuros(payment.amount)}` : ""}
        description={
          payment && (
            <div className="space-y-3">
              <p>
                {methodLabel(payment.method)}
                {client ? ` · ${client}` : ""}. Puedes devolver hasta <strong>{formatEuros(left)}</strong>
                {payment.refundedAmount ? ` (ya se devolvieron ${formatEuros(payment.refundedAmount)})` : ""}. El dinero
                se devuelve en el salón{payment.method === "wallet" ? ": vuelve a la cartera de la clienta" : ""}.
              </p>
              {linesLoading && <p className="text-xs text-gray-500">Cargando las líneas de la venta…</p>}
              {lines.length > 0 && (
                <fieldset className="space-y-2 rounded-md border border-gray-200 p-3">
                  <legend className="px-1 text-xs font-medium text-gray-700">Qué devuelve (opcional)</legend>
                  <ul className="space-y-2">
                    {lines.map((line) => (
                      <li key={line.id} className="flex items-center justify-between gap-3 text-sm">
                        <span className="min-w-0 flex-1">
                          <span className="block truncate">{line.description}</span>
                          <span className="block text-xs text-gray-500">
                            {line.kind === "product" ? "Producto" : "Servicio"} · quedan {line.refundableQuantity} de{" "}
                            {line.quantity} · {formatEuros(line.refundableCents)}
                          </span>
                        </span>
                        <input
                          type="number"
                          min={0}
                          max={line.refundableQuantity}
                          step={1}
                          value={picks[line.id] ?? 0}
                          onChange={(e) => pick(line, Math.floor(Number(e.target.value) || 0))}
                          className="w-16 rounded-md border border-gray-300 px-2 py-1 text-right text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          aria-label={`Unidades de ${line.description} a devolver`}
                        />
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-gray-500">
                    {picked.lines.length
                      ? `Los productos elegidos vuelven al stock. Valen ${formatEuros(picked.valueCents)}.`
                      : "Sin elegir líneas, la devolución es solo de importe y el stock no cambia."}
                  </p>
                </fieldset>
              )}
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-700">Importe a devolver (€)</span>
                <input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  aria-label="Importe a devolver en euros"
                />
              </label>
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-gray-700">Motivo</span>
                <textarea
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  maxLength={500}
                  rows={2}
                  placeholder="Por ejemplo: cobro duplicado, error de importe"
                  className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </label>
              {error && (
                <p role="alert" className="text-xs text-red-700">
                  {error}
                </p>
              )}
            </div>
          )
        }
        confirmLabel="Devolver"
        cancelLabel="Cancelar"
        destructive
        loading={saving}
        onCancel={onClose}
        onConfirm={submit}
      />
      <ConfirmDialog
        open={!!invoice}
        title="Emite la factura rectificativa"
        description={
          invoice ? (
            <>
              Esta cita tiene la factura <strong>{invoice.number}</strong> emitida. La devolución no la modifica: emite una
              factura rectificativa por el importe devuelto desde Facturas.
            </>
          ) : undefined
        }
        confirmLabel="Ir a Facturas"
        cancelLabel="Más tarde"
        onCancel={() => setInvoice(null)}
        onConfirm={() => {
          setInvoice(null);
          router.push("/dashboard/billing/invoices");
        }}
      />
    </>
  );
}
