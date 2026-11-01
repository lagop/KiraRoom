"use client";

import { useState } from "react";
import apiClient from "@/lib/api";
import {
  TENDER_LABELS,
  addTenderRow,
  changeCents,
  euros,
  eurosInput,
  refillRows,
  remainingCents,
  tendersOfRows,
  type TenderMethod,
  type TenderRow,
} from "@/lib/pos-cart";

const METHODS: TenderMethod[] = ["cash", "card", "bizum", "bank_transfer", "gift_card"];

interface TenderPanelProps {
  /** What is due, money cents (the server's quote). */
  dueCents: number;
  rows: TenderRow[];
  onChange: (rows: TenderRow[]) => void;
  /** A client is chosen: her wallet can pay. */
  canUseWallet?: boolean;
  disabled?: boolean;
}

/**
 * How the client pays: one method (cash with "Entregado" and "Cambio"),
 * or several (the last one takes what is left). A gift card is paid with
 * its code; its balance can be checked first.
 */
export default function TenderPanel({ dueCents, rows, onChange, canUseWallet, disabled }: TenderPanelProps) {
  const [checking, setChecking] = useState<number | null>(null);
  const [cardError, setCardError] = useState<string | null>(null);
  const methods = canUseWallet ? [...METHODS, "wallet" as TenderMethod] : METHODS;
  const tenders = tendersOfRows(rows, dueCents);
  const valid = tenders.every((t) => t.amount >= 0);
  const change = valid ? changeCents(tenders, dueCents) : 0;
  const missing = valid ? remainingCents(tenders, dueCents) : 0;
  const single = rows.length === 1;

  const setRow = (index: number, patch: Partial<TenderRow>) => {
    const next = rows.map((r, i) => (i === index ? { ...r, ...patch } : r));
    onChange("amountText" in patch ? refillRows(next, dueCents, index) : next);
  };

  const checkBalance = async (index: number) => {
    const code = rows[index].giftCardCode?.trim();
    if (!code) return;
    setChecking(index);
    setCardError(null);
    try {
      const card = await apiClient.lookupGiftCard(code);
      const balance = Number(card?.currentBalance ?? 0);
      if (card?.status && card.status !== "active") {
        setCardError("Esta tarjeta regalo no se puede usar (caducada, agotada o desactivada).");
        setRow(index, { balanceCents: balance });
        return;
      }
      const others = tendersOfRows(rows, dueCents).reduce((s, t, i) => (i === index ? s : s + Math.max(0, t.amount)), 0);
      const take = Math.max(0, Math.min(balance, dueCents - others));
      const next = rows.map((r, i) => (i === index ? { ...r, balanceCents: balance, amountText: eurosInput(take) } : r));
      // What the card does not cover goes to another method.
      if (take < dueCents - others && next.length === 1) onChange(addTenderRow(next, dueCents));
      else onChange(refillRows(next, dueCents, index));
    } catch (err) {
      setCardError(err instanceof Error ? err.message : "No se encontró la tarjeta regalo.");
    } finally {
      setChecking(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="text-sm font-medium text-gray-700">Forma de pago</div>
      {single && (
        <div className="grid grid-cols-3 gap-2" role="group" aria-label="Forma de pago">
          {methods.map((m) => (
            <button
              key={m}
              type="button"
              disabled={disabled}
              aria-pressed={rows[0].method === m}
              onClick={() => onChange([{ method: m, amountText: "" }])}
              className={`rounded-lg py-2 text-sm font-semibold transition-colors ${
                rows[0].method === m ? "bg-blue-600 text-white ring-2 ring-blue-300" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
              }`}
            >
              {TENDER_LABELS[m]}
            </button>
          ))}
        </div>
      )}

      {rows.map((row, index) => (
        <div key={index} className={single ? "" : "rounded-lg border p-2"}>
          {!single && (
            <div className="flex items-center gap-2">
              <select
                aria-label="Forma de pago"
                value={row.method}
                disabled={disabled}
                onChange={(e) => setRow(index, { method: e.target.value as TenderMethod, giftCardCode: undefined, balanceCents: undefined })}
                className="flex-1 rounded border px-2 py-1 text-sm"
              >
                {methods.map((m) => (
                  <option key={m} value={m}>
                    {TENDER_LABELS[m]}
                  </option>
                ))}
              </select>
              <input
                aria-label={`Importe en ${TENDER_LABELS[row.method]}`}
                inputMode="decimal"
                value={row.amountText}
                disabled={disabled}
                onChange={(e) => setRow(index, { amountText: e.target.value })}
                className="w-24 rounded border px-2 py-1 text-right text-sm"
              />
              <span className="text-sm text-gray-500">€</span>
              <button
                type="button"
                aria-label="Quitar esta forma de pago"
                disabled={disabled}
                onClick={() => {
                  const next = rows.filter((_, i) => i !== index);
                  onChange(next.length === 1 ? [{ ...next[0], amountText: "" }] : refillRows(next, dueCents, -1));
                }}
                className="px-1 text-red-600"
              >
                ×
              </button>
            </div>
          )}

          {single && row.method === "cash" && (
            <div className="mt-2 flex items-center gap-2">
              <label htmlFor="pos-cash-given" className="text-sm text-gray-700">
                Entregado
              </label>
              <input
                id="pos-cash-given"
                inputMode="decimal"
                placeholder={eurosInput(dueCents)}
                value={row.amountText}
                disabled={disabled}
                onChange={(e) => onChange([{ ...row, amountText: e.target.value }])}
                className="w-28 rounded border px-2 py-1 text-right"
              />
              <span className="text-sm text-gray-500">€</span>
            </div>
          )}

          {row.method === "gift_card" && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <input
                aria-label="Código de la tarjeta regalo"
                placeholder="Código de la tarjeta"
                value={row.giftCardCode ?? ""}
                disabled={disabled}
                onChange={(e) => setRow(index, { giftCardCode: e.target.value, balanceCents: undefined })}
                className="flex-1 min-w-[10rem] rounded border px-2 py-1 text-sm uppercase"
              />
              <button
                type="button"
                disabled={disabled || checking === index || !row.giftCardCode?.trim()}
                onClick={() => void checkBalance(index)}
                className="rounded border px-2 py-1 text-sm text-blue-700 hover:bg-blue-50 disabled:opacity-50"
              >
                {checking === index ? "Consultando…" : "Ver saldo"}
              </button>
              {typeof row.balanceCents === "number" && (
                <span className="text-xs text-gray-600">Saldo: {euros(row.balanceCents)}</span>
              )}
            </div>
          )}
        </div>
      ))}
      {cardError && (
        <div role="alert" className="text-xs text-red-700">
          {cardError}
        </div>
      )}

      <div className="flex items-center justify-between text-sm">
        <button
          type="button"
          disabled={disabled || dueCents === 0}
          onClick={() => onChange(addTenderRow(rows, dueCents))}
          className="text-blue-700 hover:underline disabled:opacity-50"
        >
          + Otra forma de pago
        </button>
        {valid && missing > 0 && <span className="font-semibold text-amber-700">Falta: {euros(missing)}</span>}
        {valid && missing === 0 && change > 0 && (
          <span className="text-base font-bold text-green-700">Cambio: {euros(change)}</span>
        )}
      </div>
    </div>
  );
}
