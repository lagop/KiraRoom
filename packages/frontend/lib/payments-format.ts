/**
 * How the Pagos page and the till show a payment: Spanish labels for the
 * real statuses and methods (the server's PaymentStatus / PaymentMethod
 * enums), euros the Spanish way ("50,00 €"), what a payment was for, and
 * how much of it can still be refunded. Amounts are cents.
 */

export type PaymentStatusKey = "pending" | "paid" | "failed" | "refunded";
export type PaymentMethodKey = "cash" | "card" | "bizum" | "bank_transfer" | "wallet" | "gift_card" | "loyalty_points";

/** The server's statuses, in the order the filter lists them. */
export const PAYMENT_STATUS_LABELS: Record<PaymentStatusKey, string> = {
  paid: "Pagado",
  pending: "Pendiente",
  refunded: "Devuelto",
  failed: "Fallido",
};

/** The methods a salon charges with, in the order the filter lists them. */
export const PAYMENT_METHOD_LABELS: Record<PaymentMethodKey, string> = {
  cash: "Efectivo",
  card: "Tarjeta",
  bizum: "Bizum",
  bank_transfer: "Transferencia",
  wallet: "Cartera",
  gift_card: "Tarjeta regalo",
  loyalty_points: "Puntos",
};

export function statusLabel(status: string): string {
  return PAYMENT_STATUS_LABELS[status as PaymentStatusKey] ?? status;
}

export function methodLabel(method: string): string {
  return PAYMENT_METHOD_LABELS[method as PaymentMethodKey] ?? method;
}

/** 5000 -> "50,00 €". */
export function formatEuros(cents: number | null | undefined): string {
  const value = typeof cents === "number" && Number.isFinite(cents) ? cents : 0;
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format(value / 100);
}

/**
 * "12,50", "12.50", "12" or "12,5 €" -> 1250. Null when it is not an amount
 * with at most two decimals, or not above 0.
 */
export function parseEurosToCents(input: string): number | null {
  const clean = input.replace(/\s|€/g, "");
  if (!/^\d+([.,]\d{1,2})?$/.test(clean)) return null;
  const [whole, dec = ""] = clean.replace(",", ".").split(".");
  const cents = Number(whole) * 100 + Number(dec.padEnd(2, "0"));
  return cents > 0 ? cents : null;
}

export interface PaymentLike {
  amount: number;
  status: string;
  description?: string | null;
  metadata?: Record<string, unknown> | null;
  refundedAmount?: number | null;
  appointment?: { service?: { name?: string | null } | null } | null;
}

/** What a payment was for: its appointment's service, else a till sale. */
export function paymentConcept(p: PaymentLike): string {
  const service = p.appointment?.service?.name;
  if (service) return service;
  const desc = (p.description ?? "").trim();
  const sale = desc.replace(/^POS Sale:\s*/i, "");
  if (p.metadata?.posSaleId || sale !== desc) return sale ? `Venta en caja: ${sale}` : "Venta en caja";
  return desc || "—";
}

/** Cents that can still be given back: a paid payment, less what was refunded. */
export function refundableCents(p: Pick<PaymentLike, "amount" | "status" | "refundedAmount">): number {
  if (p.status !== "paid") return 0;
  return Math.max(0, p.amount - (p.refundedAmount ?? 0));
}

/** A line of a till sale as GET /payments/:id/refund-lines lists it (cents). */
export interface RefundableSaleLine {
  id: string;
  kind: string;
  description: string;
  quantity: number;
  refundedQuantity: number;
  refundableQuantity: number;
  totalCents: number;
  refundedCents: number;
  refundableCents: number;
}

/**
 * What `quantity` units of a line are worth now, as the server works it out
 * (payments/refund-lines.ts unitsValueCents): their share of the line, and
 * all that is left of it for its last units.
 */
export function unitsValueCents(line: RefundableSaleLine, quantity: number): number {
  if (quantity <= 0) return 0;
  if (quantity >= line.refundableQuantity) return line.refundableCents;
  if (line.quantity <= 0) return 0;
  return Math.min(line.refundableCents, Math.round((line.totalCents * quantity) / line.quantity));
}

/** The lines picked (id -> units, 0 left out), as the refund's `lines`, and what they are worth. */
export function pickedLines(
  lines: RefundableSaleLine[],
  picks: Record<string, number>,
): { lines: Array<{ lineId: string; quantity: number }>; valueCents: number } {
  const chosen = lines
    .map((l) => ({ line: l, quantity: Math.max(0, Math.min(l.refundableQuantity, Math.floor(picks[l.id] ?? 0))) }))
    .filter((c) => c.quantity > 0);
  return {
    lines: chosen.map((c) => ({ lineId: c.line.id, quantity: c.quantity })),
    valueCents: chosen.reduce((s, c) => s + unitsValueCents(c.line, c.quantity), 0),
  };
}
