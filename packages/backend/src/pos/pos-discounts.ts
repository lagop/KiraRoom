import { BadRequestException, ForbiddenException } from "@nestjs/common";

/**
 * Discounts given by hand at the till: "10 % a esta clienta", "5 € menos".
 *
 * Since the till prices every line from the database (#173), a cashier can
 * no longer type a lower price. A discount is instead an explicit request,
 * on a line or on the whole ticket, that the server turns into cents here,
 * checks against who is at the till, and records (PosDiscount). The client
 * sends only the type, the value and the reason, never an amount to charge.
 *
 * Money is integer cents throughout. Rounding is half up on exact integer
 * arithmetic: 10 % of 19,99 EUR is 2,00 EUR (199,9 cents rounds to 200).
 *
 * Order of application:
 *   1. each line's own discount, off that line (unit price x quantity);
 *   2. the ticket's discount, off what the lines add up to after (1);
 *      it is then shared over the lines in proportion to what each one
 *      still costs (largest remainder, so the shares add up exactly), so
 *      an appointment knows its part and the invoice can show it per line;
 *   3. a promotion code, if any, off what the lines cost after (1) and (2),
 *      shared by tax base, outside the staff limit below
 *      (promotions/promotion-at-till.ts);
 *   4. a loyalty reward, if any, comes off what is left (pos.service.ts);
 *   5. a gift card pays what remains, as a tender (pos-tenders.ts).
 */

export const POS_DISCOUNT_TYPES = ["percentage", "fixed"] as const;
export type PosDiscountType = (typeof POS_DISCOUNT_TYPES)[number];

/** As the till sends it: a percent (0-100, up to 2 decimals) or cents. */
export interface DiscountSpec {
  type: PosDiscountType;
  value: number;
  reason?: string;
}

/** The roles that may always discount (SALON_MANAGERS: owner and manager). */
const UNLIMITED_ROLES = ["owner", "admin"];

function euros(cents: number): string {
  return (cents / 100).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

/** A percent as hundredths (12.5 -> 1250), so the arithmetic stays in integers. */
function hundredths(percent: number): number {
  return Math.round(percent * 100);
}

/**
 * What a discount takes off `baseCents`, in cents. 400 for a fixed amount
 * above the base or a percent outside 0-100 (the DTO already refuses those;
 * this keeps the rule next to the arithmetic).
 */
export function discountCents(spec: DiscountSpec, baseCents: number, what = "de la línea"): number {
  const value = Number(spec.value);
  if (!Number.isFinite(value) || value < 0) {
    throw new BadRequestException("El descuento no puede ser negativo.");
  }
  if (spec.type === "percentage") {
    if (value > 100) throw new BadRequestException("Un descuento en porcentaje va de 0 a 100.");
    // base x hundredths is an integer; one division, then half up.
    return Math.round((baseCents * hundredths(value)) / 10_000);
  }
  if (spec.type === "fixed") {
    if (!Number.isInteger(value)) throw new BadRequestException("Un descuento fijo va en céntimos enteros.");
    if (value > baseCents) {
      throw new BadRequestException(`El descuento (${euros(value)}) supera el importe ${what} (${euros(baseCents)}).`);
    }
    return value;
  }
  throw new BadRequestException("Tipo de descuento desconocido.");
}

/**
 * Splits `totalCents` over `weights` in proportion, in whole cents that add
 * up exactly (largest remainder; ties go to the earlier entry). All-zero
 * weights get nothing.
 */
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

/** A line as the server priced it (cents per unit), with the discount asked for it. */
export interface DiscountableLine {
  price: number;
  quantity: number;
  discount?: DiscountSpec;
}

export interface DiscountedAmounts {
  /** price x quantity. */
  grossCents: number;
  /** The line's own discount. */
  lineDiscountCents: number;
  /** Its share of the ticket's discount. */
  orderDiscountCents: number;
  /** What the line costs after both. */
  netCents: number;
}

export interface DiscountedTicket<L> {
  lines: Array<L & DiscountedAmounts>;
  /** The lines at their prices, before any discount. */
  subtotalCents: number;
  lineDiscountsCents: number;
  /** What the ticket's own discount came off: the lines after their discounts. */
  orderBaseCents: number;
  orderDiscountCents: number;
  /** Every manual discount of the ticket. */
  discountCents: number;
  /** subtotal - discounts (before a loyalty reward). */
  totalCents: number;
}

/** Applies each line's discount, then the ticket's (see the order above). */
export function applyDiscounts<L extends DiscountableLine>(
  lines: L[],
  orderDiscount?: DiscountSpec | null,
): DiscountedTicket<L> {
  const afterLines = lines.map((line) => {
    const grossCents = line.price * line.quantity;
    const lineDiscountCents = line.discount ? discountCents(line.discount, grossCents) : 0;
    return { line, grossCents, lineDiscountCents };
  });
  const subtotalCents = afterLines.reduce((s, l) => s + l.grossCents, 0);
  const lineDiscountsCents = afterLines.reduce((s, l) => s + l.lineDiscountCents, 0);
  const orderBaseCents = subtotalCents - lineDiscountsCents;
  const orderDiscountCents = orderDiscount ? discountCents(orderDiscount, orderBaseCents, "del ticket") : 0;
  const shares = allocateCents(
    orderDiscountCents,
    afterLines.map((l) => l.grossCents - l.lineDiscountCents),
  );
  const out = afterLines.map((l, i) => ({
    ...l.line,
    grossCents: l.grossCents,
    lineDiscountCents: l.lineDiscountCents,
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

/** Whether a spec takes anything off (a 0 % or 0 cent discount is no discount). */
export function isDiscount(spec?: DiscountSpec | null): spec is DiscountSpec {
  return !!spec && Number(spec.value) > 0;
}

/**
 * 403 unless the actor may give these discounts. The owner and managers
 * always may. Anyone else (staff) up to the salon's
 * `maxStaffDiscountPercent` per line: the line's own discount and its part
 * of the ticket's, together, may not take more than that percent off the
 * line. Compared on the rates asked for (exact), not on rounded cents, so
 * 10 % is within a 10 % limit even when it rounds 199,9 cents up to 200.
 */
export function assertDiscountAllowed(
  actorRole: string | undefined,
  maxStaffPercent: number,
  ticket: DiscountedTicket<DiscountableLine>,
  orderDiscount?: DiscountSpec | null,
): void {
  if (ticket.discountCents <= 0) return;
  if (actorRole && UNLIMITED_ROLES.includes(actorRole)) return;

  const max = Math.max(0, Math.min(100, Math.floor(Number(maxStaffPercent) || 0)));
  if (max === 0) {
    throw new ForbiddenException("Solo la propietaria o un encargado pueden aplicar descuentos en caja.");
  }
  const rate = (spec: DiscountSpec | undefined | null, base: number): number => {
    if (!isDiscount(spec)) return 0;
    if (spec.type === "percentage") return Number(spec.value) / 100;
    return base > 0 ? Number(spec.value) / base : 0;
  };
  const orderRate = rate(orderDiscount, ticket.orderBaseCents);
  for (const line of ticket.lines) {
    if (line.grossCents <= 0) continue;
    const combined = 1 - (1 - rate(line.discount, line.grossCents)) * (1 - orderRate);
    if (combined > max / 100 + 1e-9) {
      throw new ForbiddenException(
        `Tu límite de descuento es del ${max} % por línea. Para descontar más, pide a un encargado que lo aplique.`,
      );
    }
  }
}
