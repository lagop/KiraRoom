"use client";

import { useState } from "react";
import { parseEurosInput, type GiftCardSale } from "@/lib/pos-cart";

interface GiftCardSaleDialogProps {
  onAdd: (card: Omit<GiftCardSale, "key">) => void;
  onClose: () => void;
}

const MIN_CENTS = 100;
const MAX_CENTS = 1_000_000;

/**
 * "Vender tarjeta regalo": the amount, who it is for and a message. It goes
 * on the ticket as its own line (no VAT: it is taxed when it is spent) and
 * is issued when the sale is charged; with an email, the card is sent to it.
 */
export default function GiftCardSaleDialog({ onAdd, onClose }: GiftCardSaleDialogProps) {
  const [amount, setAmount] = useState("");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const cents = parseEurosInput(amount);
  const amountProblem =
    amount.trim() === ""
      ? null
      : cents === null
        ? "Escribe un importe en euros (por ejemplo 50 o 25,50)."
        : cents < MIN_CENTS || cents > MAX_CENTS
          ? "El importe va de 1 € a 10.000 €."
          : null;
  const emailProblem = email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim()) ? "El email no es válido." : null;
  const ready = cents !== null && !amountProblem && !emailProblem;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="gift-card-sale-title">
      <form
        className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          if (!ready || cents === null) return;
          onAdd({ amountCents: cents, recipientName: name, recipientEmail: email, message });
          onClose();
        }}
      >
        <h2 id="gift-card-sale-title" className="mb-1 text-lg font-semibold">
          Vender tarjeta regalo
        </h2>
        <p className="mb-4 text-sm text-gray-500">
          Se cobra con el resto del ticket. No lleva IVA: se aplica cuando se gaste en un servicio o producto.
        </p>
        <div className="space-y-3">
          <div>
            <label htmlFor="gc-amount" className="mb-1 block text-sm font-medium">
              Importe (€) *
            </label>
            <input id="gc-amount" inputMode="decimal" required value={amount} onChange={(e) => setAmount(e.target.value)} className="w-full rounded border px-3 py-2" />
            {amountProblem && <p className="mt-1 text-xs text-red-700">{amountProblem}</p>}
          </div>
          <div>
            <label htmlFor="gc-name" className="mb-1 block text-sm font-medium">
              Para (nombre)
            </label>
            <input id="gc-name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} className="w-full rounded border px-3 py-2" />
          </div>
          <div>
            <label htmlFor="gc-email" className="mb-1 block text-sm font-medium">
              Email de quien la recibe
            </label>
            <input id="gc-email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="w-full rounded border px-3 py-2" />
            <p className="mt-1 text-xs text-gray-500">Con email, se le envía la tarjeta al cobrar.</p>
            {emailProblem && <p className="mt-1 text-xs text-red-700">{emailProblem}</p>}
          </div>
          <div>
            <label htmlFor="gc-message" className="mb-1 block text-sm font-medium">
              Mensaje
            </label>
            <textarea id="gc-message" maxLength={500} rows={2} value={message} onChange={(e) => setMessage(e.target.value)} className="w-full rounded border px-3 py-2" />
          </div>
        </div>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="rounded border px-4 py-2 text-sm hover:bg-gray-50">
            Cancelar
          </button>
          <button type="submit" disabled={!ready} className="rounded bg-blue-600 px-4 py-2 text-sm text-white hover:bg-blue-700 disabled:bg-blue-300">
            Añadir al ticket
          </button>
        </div>
      </form>
    </div>
  );
}
