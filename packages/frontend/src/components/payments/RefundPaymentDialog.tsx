"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import apiClient, { type Payment, type PaymentRefundResult } from "@/lib/api";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { useToast } from "@/components/ui/use-toast";
import { formatEuros, methodLabel, parseEurosToCents, refundableCents } from "@/lib/payments-format";

type RefundablePayment = Pick<Payment, "id" | "amount" | "status" | "method" | "refundedAmount" | "client">;

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

  const left = payment ? refundableCents(payment) : 0;

  React.useEffect(() => {
    if (!payment) return;
    setAmount((refundableCents(payment) / 100).toFixed(2).replace(".", ","));
    setReason("");
    setError(null);
  }, [payment]);

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
    if (!reason.trim()) {
      setError("Indica el motivo de la devolución.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const result = await apiClient.refundPayment(payment.id, {
        // All that is left: let the server work it out from its own figures.
        ...(cents === left ? {} : { amount: cents }),
        reason: reason.trim(),
      });
      toast({
        title: cents === left ? "Cobro devuelto" : "Devolución registrada",
        description: `${formatEuros(cents)} devueltos${payment.method === "wallet" ? " a la cartera de la clienta" : ""}.`,
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
