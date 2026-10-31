"use client";

import { useEffect, useState } from "react";
import {
  MAX_REASON_LENGTH,
  describeDiscount,
  discountCents,
  discountProblem,
  formatEuros,
  specFromInput,
  type DiscountSpec,
  type DiscountType,
} from "@/lib/pos-discounts";

interface DiscountEditorProps {
  /** The discount applied now, if any. */
  value?: DiscountSpec;
  /** What the discount comes off, in cents (for the € cap and the preview). */
  baseCents: number;
  /** What it is on, in the messages: "la línea" or "el ticket". */
  scope: "la línea" | "el ticket";
  /** Cents it takes off as the panel works it out (display only). */
  amountCents: number;
  onChange: (spec: DiscountSpec | undefined) => void;
  disabled?: boolean;
}

/**
 * "Descuento" on a cart line or on the whole ticket: % or €, an optional
 * reason, applied or removed. It only describes the discount; the server
 * works the amount out and decides whether this person may give it.
 */
export default function DiscountEditor({ value, baseCents, scope, amountCents, onChange, disabled }: DiscountEditorProps) {
  const [open, setOpen] = useState(false);
  const [type, setType] = useState<DiscountType>(value?.type ?? "percentage");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState(value?.reason ?? "");

  useEffect(() => {
    if (!open) return;
    setType(value?.type ?? "percentage");
    setAmount(
      value ? (value.type === "percentage" ? String(value.value) : (value.value / 100).toFixed(2)).replace(".", ",") : "",
    );
    setReason(value?.reason ?? "");
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const spec = specFromInput(type, amount, reason);
  const problem = spec ? discountProblem(spec, baseCents, scope) : null;
  const label = scope === "la línea" ? "Descuento en la línea" : "Descuento en el ticket";

  if (!open) {
    return (
      <div className="mt-1 flex items-center gap-2 text-xs">
        {value ? (
          <>
            <span className="rounded bg-rose-50 px-1.5 py-0.5 text-rose-700">
              Dto. {describeDiscount(value)} (−{formatEuros(amountCents)})
              {value.reason ? ` · ${value.reason}` : ""}
            </span>
            <button type="button" className="text-blue-600 hover:underline" onClick={() => setOpen(true)} disabled={disabled}>
              Cambiar
            </button>
            <button type="button" className="text-red-600 hover:underline" onClick={() => onChange(undefined)} disabled={disabled}>
              Quitar
            </button>
          </>
        ) : (
          <button type="button" className="text-blue-600 hover:underline" onClick={() => setOpen(true)} disabled={disabled}>
            + Descuento
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-lg border border-gray-200 bg-gray-50 p-2 text-sm" role="group" aria-label={label}>
      <div className="mb-2 text-xs font-medium text-gray-600">{label}</div>
      <div className="flex items-center gap-2">
        <div className="inline-flex overflow-hidden rounded border" role="radiogroup" aria-label="Tipo de descuento">
          {(["percentage", "fixed"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={type === option}
              onClick={() => setType(option)}
              className={`px-2 py-1 text-xs font-semibold ${type === option ? "bg-blue-600 text-white" : "bg-white text-gray-600"}`}
            >
              {option === "percentage" ? "%" : "€"}
            </button>
          ))}
        </div>
        <input
          type="text"
          inputMode="decimal"
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={type === "percentage" ? "10" : "5,00"}
          aria-label={type === "percentage" ? "Porcentaje de descuento" : "Importe del descuento en euros"}
          className="w-20 rounded border px-2 py-1"
        />
        <span className="text-xs text-gray-500">
          {spec && !problem ? `−${formatEuros(discountCents(spec, baseCents))}` : ""}
        </span>
      </div>
      <input
        type="text"
        value={reason}
        maxLength={MAX_REASON_LENGTH}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Motivo (opcional)"
        aria-label="Motivo del descuento"
        className="mt-2 w-full rounded border px-2 py-1"
      />
      {problem && <div className="mt-1 text-xs text-red-600">{problem}</div>}
      <div className="mt-2 flex justify-end gap-2">
        <button type="button" className="px-2 py-1 text-xs text-gray-600 hover:underline" onClick={() => setOpen(false)}>
          Cancelar
        </button>
        <button
          type="button"
          disabled={!spec || !!problem || disabled}
          onClick={() => {
            onChange(spec && spec.value > 0 ? spec : undefined);
            setOpen(false);
          }}
          className="rounded bg-blue-600 px-3 py-1 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-gray-300"
        >
          Aplicar
        </button>
      </div>
    </div>
  );
}
