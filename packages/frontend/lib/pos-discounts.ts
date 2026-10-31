/**
 * Discounts at the till (TPV), as the panel shows them while the cashier
 * builds the ticket. Display only: the server works the real amounts out
 * from its own prices (packages/backend/src/pos/pos-discounts.ts) and is
 * the one that decides. The arithmetic is the same, in integer cents, so
 * the total shown, and the amount the panel tenders, are what the server
 * charges:
 *
 *   1. each line's own discount, off that line (price x quantity);
 *   2. the ticket's discount, off what is left, shared over the lines in
 *      proportion (largest remainder);
 *   3. a loyalty reward on what is left after that (pos/page.tsx).
 *
 * Percentages round half up to the cent: 10 % of 19,99 € is 2,00 €.
 */

export type DiscountType = "percentage" | "fixed";

/** What the panel sends: a percent (0-100, 2 decimals) or cents. Never a price. */
export interface DiscountSpec {
  type: DiscountType;
  value: number;
  reason?: string;
}

export interface DiscountableLine {
  /** Cents per unit. */
  price: number;
  quantity: number;
  discount?: DiscountSpec;
}

export interface DiscountedLine {
  grossCents: number;
  lineDiscountCents: number;
  orderDiscountCents: number;
  netCents: number;
}

export interface DiscountedTicket {
  lines: DiscountedLine[];
  subtotalCents: number;
  lineDiscountsCents: number;
  orderBaseCents: number;
  orderDiscountCents: number;
  discountCents: number;
  totalCents: number;
}

export const MAX_REASON_LENGTH = 120;

export function formatEuros(cents: number): string {
  return (cents / 100).toLocaleString("es-ES", { style: "currency", currency: "EUR" });
}

/** Whether a spec takes anything off. */
export function isDiscount(spec?: DiscountSpec | null): spec is DiscountSpec {
  return !!spec && Number(spec.value) > 0;
}

/**
 * What a discount takes off `baseCents`. A fixed amount above the base is
 * shown capped at the base; the server refuses it (see discountProblem).
 */
export function discountCents(spec: DiscountSpec | undefined | null, baseCents: number): number {
  if (!isDiscount(spec)) return 0;
  if (spec.type === "percentage") {
    const hundredths = Math.round(Math.min(100, spec.value) * 100);
    return Math.round((baseCents * hundredths) / 10_000);
  }
  return Math.min(Math.round(spec.value), baseCents);
}

/** Splits cents in proportion, adding up exactly (largest remainder, ties to the first). */
export function allocateCents(totalCents: number, weights: number[]): number[] {
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0);
  if (totalCents <= 0 || sum <= 0) return weights.map(() => 0);
  const exact = weights.map((w) => (totalCents * Math.max(0, w)) / sum);
  const shares = exact.map(Math.floor);
  let left = totalCents - shares.reduce((s, x) => s + x, 0);
  const order = exact
    .map((x, i) => ({ i, rest: x - Math.floor(x) }))
    .sort((a, b) => b.rest - a.rest || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    shares[i] += 1;
    left -= 1;
  }
  return shares;
}

export function applyDiscounts(lines: DiscountableLine[], orderDiscount?: DiscountSpec | null): DiscountedTicket {
  const after = lines.map((l) => {
    const grossCents = l.price * l.quantity;
    return { grossCents, lineDiscountCents: discountCents(l.discount, grossCents) };
  });
  const subtotalCents = after.reduce((s, l) => s + l.grossCents, 0);
  const lineDiscountsCents = after.reduce((s, l) => s + l.lineDiscountCents, 0);
  const orderBaseCents = subtotalCents - lineDiscountsCents;
  const orderDiscountCents = discountCents(orderDiscount, orderBaseCents);
  const shares = allocateCents(
    orderDiscountCents,
    after.map((l) => l.grossCents - l.lineDiscountCents),
  );
  const out = after.map((l, i) => ({
    ...l,
    orderDiscountCents: shares[i],
    netCents: l.grossCents - l.lineDiscountCents - shares[i],
  }));
  const discount = lineDiscountsCents + orderDiscountCents;
  return {
    lines: out,
    subtotalCents,
    lineDiscountsCents,
    orderBaseCents,
    orderDiscountCents,
    discountCents: discount,
    totalCents: subtotalCents - discount,
  };
}

/**
 * The spec for what the cashier typed: a percent, or euros ("5", "5,50")
 * turned into cents. Null when it is not a number.
 */
export function specFromInput(type: DiscountType, input: string, reason?: string): DiscountSpec | null {
  const n = Number(String(input).trim().replace(",", "."));
  if (!String(input).trim() || !Number.isFinite(n)) return null;
  const value = type === "percentage" ? Math.round(n * 100) / 100 : Math.round(n * 100);
  const r = reason?.trim();
  return { type, value, ...(r ? { reason: r.slice(0, MAX_REASON_LENGTH) } : {}) };
}

/** What a spec looks like on the ticket: "10 %", "5,00 €". */
export function describeDiscount(spec: DiscountSpec): string {
  return spec.type === "percentage"
    ? `${spec.value.toLocaleString("es-ES", { maximumFractionDigits: 2 })} %`
    : formatEuros(spec.value);
}

/**
 * Why the server would refuse this discount on `baseCents`, in the words
 * the panel shows, or null. `what`: "la línea" or "el ticket".
 */
export function discountProblem(spec: DiscountSpec, baseCents: number, what: "la línea" | "el ticket"): string | null {
  if (!Number.isFinite(spec.value) || spec.value < 0) return "El descuento no puede ser negativo.";
  if (spec.type === "percentage" && spec.value > 100) return "Un descuento en porcentaje va de 0 a 100.";
  if (spec.type === "fixed" && spec.value > baseCents) {
    return `El descuento (${formatEuros(spec.value)}) supera el importe ${what === "la línea" ? "de la línea" : "del ticket"} (${formatEuros(baseCents)}).`;
  }
  return null;
}

/**
 * For a staff member: the message the server would answer with (403), or
 * null when the ticket is within their limit. Same rule as the server: each
 * line's own discount and its part of the ticket's, together, at most
 * `maxPercent` of the line, on the rates asked for.
 */
export function staffLimitProblem(
  lines: DiscountableLine[],
  orderDiscount: DiscountSpec | null | undefined,
  maxPercent: number,
): string | null {
  const ticket = applyDiscounts(lines, orderDiscount);
  if (ticket.discountCents <= 0) return null;
  const max = Math.max(0, Math.min(100, Math.floor(Number(maxPercent) || 0)));
  if (max === 0) return "Solo la propietaria o un encargado pueden aplicar descuentos en caja.";
  const rate = (spec: DiscountSpec | null | undefined, base: number) => {
    if (!isDiscount(spec)) return 0;
    if (spec.type === "percentage") return spec.value / 100;
    return base > 0 ? spec.value / base : 0;
  };
  const orderRate = rate(orderDiscount, ticket.orderBaseCents);
  for (let i = 0; i < lines.length; i++) {
    const gross = ticket.lines[i].grossCents;
    if (gross <= 0) continue;
    if (1 - (1 - rate(lines[i].discount, gross)) * (1 - orderRate) > max / 100 + 1e-9) {
      return `Tu límite de descuento es del ${max} % por línea. Para descontar más, pide a un encargado que lo aplique.`;
    }
  }
  return null;
}
