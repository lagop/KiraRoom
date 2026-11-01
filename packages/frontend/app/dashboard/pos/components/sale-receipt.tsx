"use client";

import { useEffect, useState } from "react";
import apiClient, { type PosReceipt } from "@/lib/api";
import { methodLabel } from "@/lib/payments-format";
import { euros } from "@/lib/pos-cart";

interface SaleReceiptProps {
  saleId: string;
  /** The client's email, offered for "Enviar por email". */
  clientEmail?: string | null;
  /** Owner and managers: sending an invoice is theirs (the API agrees). */
  canEmail?: boolean;
  onClose: () => void;
}

/**
 * The ticket of a sale, after it is charged: the legal minimum of a
 * simplified invoice (the salon's name, NIF and address, the invoice
 * number, date and time, the lines, the VAT rate and amount, the total).
 * "Imprimir" prints only the ticket, 80 mm wide (thermal printers);
 * "Enviar por email" sends the sale's invoice (POST /invoices/:id/email).
 */
export default function SaleReceipt({ saleId, clientEmail, canEmail, onClose }: SaleReceiptProps) {
  const [receipt, setReceipt] = useState<PosReceipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState(clientEmail ?? "");
  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    apiClient
      .getPosReceipt(saleId)
      .then((r) => alive && setReceipt(r))
      .catch((e) => alive && setError(e instanceof Error ? e.message : "No se pudo cargar el ticket."));
    return () => {
      alive = false;
    };
  }, [saleId]);

  const send = async () => {
    if (!receipt?.invoice) return;
    setSending(true);
    setSent(null);
    setError(null);
    try {
      const out = await apiClient.emailInvoice(receipt.invoice.id, email.trim() || undefined);
      setSent(out.sent ? `Enviado a ${out.to}.` : "No se pudo enviar.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "No se pudo enviar.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 print:static print:bg-transparent print:p-0">
      <style>{`
        @media print {
          @page { size: 80mm auto; margin: 3mm; }
          body * { visibility: hidden !important; }
          #pos-receipt, #pos-receipt * { visibility: visible !important; }
          #pos-receipt { position: absolute; left: 0; top: 0; width: 74mm; font-size: 11px; box-shadow: none; }
          .pos-receipt-actions { display: none !important; }
        }
      `}</style>
      <div className="w-full max-w-sm max-h-[90vh] overflow-y-auto rounded-lg bg-white shadow-xl">
        <div id="pos-receipt" className="p-4 font-mono text-sm text-gray-900">
          {!receipt && !error && <div className="py-6 text-center text-gray-500">Cargando el ticket…</div>}
          {receipt && (
            <>
              <div className="text-center">
                <div className="font-bold">{receipt.salon.name}</div>
                {receipt.salon.tradeName && receipt.salon.tradeName !== receipt.salon.name && <div>{receipt.salon.tradeName}</div>}
                {receipt.salon.taxId && <div>NIF {receipt.salon.taxId}</div>}
                {receipt.salon.address && <div>{receipt.salon.address}</div>}
                {receipt.salon.phone && <div>Tel. {receipt.salon.phone}</div>}
              </div>
              <div className="my-2 border-t border-dashed" />
              <div>
                {receipt.invoice ? (
                  <>
                    {receipt.invoice.full ? "Factura" : "Factura simplificada"} {receipt.invoice.number}
                  </>
                ) : (
                  "Ticket de venta"
                )}
              </div>
              <div>
                {receipt.date} {receipt.time}
              </div>
              {receipt.invoice?.full && receipt.invoice.recipientName && (
                <div>
                  {receipt.invoice.recipientName}
                  {receipt.invoice.recipientTaxId ? ` · NIF ${receipt.invoice.recipientTaxId}` : ""}
                </div>
              )}
              <div className="my-2 border-t border-dashed" />
              {receipt.lines.map((l, i) => (
                <div key={i} className="mb-1">
                  <div className="flex justify-between gap-2">
                    <span className="break-words">
                      {l.quantity > 1 ? `${l.quantity} × ` : ""}
                      {l.description}
                    </span>
                    <span className="whitespace-nowrap">{euros(l.totalCents)}</span>
                  </div>
                  {l.discountCents > 0 && <div className="text-xs">  Descuento −{euros(l.discountCents)}</div>}
                  {l.kind === "gift_card" && <div className="text-xs">  Sin IVA (tarjeta regalo)</div>}
                </div>
              ))}
              <div className="my-2 border-t border-dashed" />
              {receipt.promotion && receipt.promotion.discountCents > 0 && (
                <div className="flex justify-between">
                  <span>Descuento promoción {receipt.promotion.code}</span>
                  <span>−{euros(receipt.promotion.discountCents)}</span>
                </div>
              )}
              {receipt.loyaltyDiscountCents > 0 && (
                <div className="flex justify-between">
                  <span>Descuento por puntos</span>
                  <span>−{euros(receipt.loyaltyDiscountCents)}</span>
                </div>
              )}
              <div className="flex justify-between text-base font-bold">
                <span>TOTAL</span>
                <span>{euros(receipt.totalCents)}</span>
              </div>
              {receipt.taxBreakdown.map((b) => (
                <div key={b.rate} className="flex justify-between text-xs">
                  <span>
                    {receipt.taxLabel} {b.rate} % sobre {euros(b.baseCents)}
                  </span>
                  <span>{euros(b.taxCents)}</span>
                </div>
              ))}
              <div className="text-xs">{receipt.taxNote}</div>
              <div className="my-2 border-t border-dashed" />
              {receipt.payments.map((p, i) => (
                <div key={i} className="flex justify-between">
                  <span>{methodLabel(p.method)}</span>
                  <span>{euros(p.amount)}</span>
                </div>
              ))}
              {receipt.changeCents > 0 && (
                <>
                  <div className="flex justify-between">
                    <span>Entregado</span>
                    <span>{euros(receipt.tenderedCents)}</span>
                  </div>
                  <div className="flex justify-between font-bold">
                    <span>Cambio</span>
                    <span>{euros(receipt.changeCents)}</span>
                  </div>
                </>
              )}
              {receipt.giftCards.length > 0 && (
                <>
                  <div className="my-2 border-t border-dashed" />
                  {receipt.giftCards.map((g) => (
                    <div key={g.code}>
                      Tarjeta regalo {g.code}: {euros(g.amountCents)}
                    </div>
                  ))}
                </>
              )}
              <div className="mt-3 text-center text-xs">Gracias por tu visita</div>
            </>
          )}
        </div>

        <div className="pos-receipt-actions space-y-3 border-t p-4">
          {error && (
            <div role="alert" className="rounded border border-red-200 bg-red-50 p-2 text-xs text-red-700">
              {error}
            </div>
          )}
          {canEmail && receipt?.invoice && (
            <div className="flex items-center gap-2">
              <input
                type="email"
                aria-label="Email al que enviar la factura"
                placeholder="Email de la clienta"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="flex-1 rounded border px-2 py-1 text-sm"
              />
              <button
                type="button"
                onClick={() => void send()}
                disabled={sending || (!email.trim() && !clientEmail)}
                className="rounded bg-gray-800 px-3 py-1 text-sm text-white hover:bg-gray-900 disabled:opacity-50"
              >
                {sending ? "Enviando…" : "Enviar por email"}
              </button>
            </div>
          )}
          {sent && <div className="text-xs text-green-700">{sent}</div>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="rounded border px-4 py-2 text-sm hover:bg-gray-50">
              Cerrar
            </button>
            <button
              type="button"
              onClick={() => window.print()}
              disabled={!receipt}
              className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:bg-blue-300"
            >
              Imprimir
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
