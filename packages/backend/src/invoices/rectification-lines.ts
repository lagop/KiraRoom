import { BadRequestException } from "@nestjs/common";
import { InvoiceCalculator, type InvoiceLineInput } from "./invoice-calculator.service";
import { allocateCents } from "../pos/pos-discounts";

/**
 * The lines of a rectifying invoice (series R, POST /invoices/:id/rectify).
 *
 * A rectificativa that cancels an invoice has to net it to zero: the same
 * base, tax and total per line, negated. Recomputing a line from its stored
 * unit price did not: a line priced with the tax included is stored with its
 * net unit price, rounded (10,00 EUR at 21 % -> 8,26 a unit), and 8,26 with
 * 21 % on top is 9,99, so the "full" rectification left 0,01 EUR standing.
 * New salons price with the tax included (#178), so that would have been
 * the usual case.
 *
 * What is left to credit. An invoice can be rectified more than once (one
 * unit back today, a discount tomorrow), and two partial rectificativas used
 * to be able to credit the same line twice, more than was invoiced. Every
 * line that credits a line of the original now names it (rectifiesLineId),
 * and each line's remaining quantity and amounts are its own minus those of
 * every earlier non-cancelled rectificativa line naming it (`prior`). A
 * request that goes past what is left is refused (400) saying what is left.
 *
 * Lines that credit a line of the original (`originalLineId`):
 *   the whole remaining quantity -> what is left of the line, negated,
 *                         exactly (for a line never rectified: its stored
 *                         amounts, so the two invoices net to zero);
 *   part of it         -> that share of what is left of the line, split the
 *                         way the original was: with the tax included, the
 *                         share of the total is split into base + tax; with
 *                         the tax on top, the share of the base gets its
 *                         tax. Worked out on the positive amounts and then
 *                         negated, so it rounds like the original did;
 *   an amount (`amountCents`, a discount by difference, pos.service.ts) ->
 *                         that much of the line's price in the line's own
 *                         terms: with the tax included it is the total and is
 *                         split into base + tax; on top it is the base and
 *                         gets its tax. The quantity stays (one line, 1 x a
 *                         negative price): no unit is given back.
 * No lines at all: what is left of every line (a full rectification).
 * Lines without `originalLineId` are free lines (a "por diferencias" amount),
 * computed as given with the tax on top, as before.
 *
 * Credits not tied to a line. Rectificativas issued before the line link
 * existed, and free lines, cannot be told apart by line. They are taken,
 * conservatively, as already credited against the invoice as a whole: no
 * rectificativa may take the invoice past zero (`invoiceTotalCents` plus
 * every earlier credit), and a full rectification shares that amount over
 * the lines in proportion before crediting what is left. Only credits count
 * (amounts of the opposite sign to the original): a free line adding to the
 * invoice does not make more of it creditable.
 */

/** A stored InvoiceLine (Prisma Decimals arrive as objects: read with Number()). */
export interface StoredInvoiceLine {
  id: string;
  description: string;
  quantity: unknown;
  unitPriceCents: number;
  discountPct: unknown;
  taxRate: unknown;
  taxCents: number;
  totalCents: number;
  taxIncluded?: boolean | null;
  productId?: string | null;
  serviceId?: string | null;
}

export interface RectificationLineRequest {
  /** A line of the invoice being rectified; its description, price and rate are taken from it. */
  originalLineId?: string;
  description?: string;
  /**
   * Negative to credit. With originalLineId: minus what is left of its
   * quantity, or part of it. Not used with `amountCents`.
   */
  quantity?: number;
  /**
   * With originalLineId, instead of a quantity: credit this many cents of
   * the line's price, in the line's terms (with the tax if it was priced
   * with it, else the base). Not in the API body: the till uses it.
   */
  amountCents?: number;
  unitPriceCents?: number;
  discountPct?: number;
  taxRate?: number;
}

/** A line of an earlier, non-cancelled rectificativa of the same invoice. */
export interface PriorRectificationLine {
  rectifiesLineId?: string | null;
  quantity: unknown;
  taxCents: number;
  totalCents: number;
}

export interface RectificationContext {
  /** Every line of the earlier non-cancelled rectificativas of this invoice. */
  prior?: PriorRectificationLine[];
  /** The original's total: no rectificativa takes the invoice past zero. */
  invoiceTotalCents?: number;
}

const EPSILON = 1e-9;

/** What is left to credit of one line of the original. */
interface Remaining {
  line: StoredInvoiceLine;
  quantity: number;
  taxCents: number;
  totalCents: number;
  /** An earlier rectificativa (or an earlier line of this one) credited it. */
  credited: boolean;
}

interface CreditState {
  lines: Map<string, Remaining>;
  /** The sign of the original's total (1 for an ordinary invoice; 0: unknown). */
  sign: number;
  /** Earlier credits not tied to a line (legacy rectificativas, free lines), as stored. */
  unlinkedCents: number;
  /** What is left of the invoice as a whole, as stored (undefined: not checked). */
  invoiceLeftCents?: number;
}

export function rectificationLines(
  original: StoredInvoiceLine[],
  requested?: RectificationLineRequest[] | null,
  context: RectificationContext = {},
): InvoiceLineInput[] {
  const state = creditState(original, context);
  if (!requested || requested.length === 0) {
    if (original.length === 0) {
      throw new BadRequestException("La factura original no tiene líneas que rectificar");
    }
    return wholeRemaining(state);
  }

  const lines = requested.map((req) => {
    if (req.originalLineId === undefined || req.originalLineId === null) return freeLine(req);
    const r = state.lines.get(req.originalLineId);
    if (!r) {
      throw new BadRequestException(`La línea ${req.originalLineId} no es de la factura que se rectifica`);
    }
    if (req.amountCents !== undefined && req.amountCents !== null) return amountCredit(r, req.amountCents);
    return quantityCredit(r, req.quantity);
  });
  assertWithinInvoice(state, lines);
  return lines;
}

/**
 * A credit of `amountCents` of the invoice's price, by difference (a
 * discount given at the till after the invoice was issued): shared over the
 * lines in proportion to what is left of each, in each line's own terms
 * (largest remainder, so the shares add up exactly), and credited from each
 * line as an amount (see above). Refused past what is left.
 */
export function amountCreditLines(
  original: StoredInvoiceLine[],
  amountCents: number,
  context: RectificationContext = {},
): InvoiceLineInput[] {
  assertCents(amountCents);
  const state = creditState(original, context);
  const open = [...state.lines.values()].filter((r) => positiveLine(r.line) && priceLeft(r) > 0);
  const left = open.reduce((s, r) => s + priceLeft(r), 0);
  if (left <= 0) {
    throw new BadRequestException("La factura ya está abonada entera: no queda nada que rectificar");
  }
  if (amountCents > left) {
    throw new BadRequestException(
      `El abono (${euros(amountCents)}) supera lo que queda por abonar de la factura (${euros(left)})`,
    );
  }
  const shares = allocateCents(amountCents, open.map(priceLeft));
  const lines = open.flatMap((r, i) => (shares[i] > 0 ? [amountCredit(r, shares[i])] : []));
  assertWithinInvoice(state, lines);
  return lines;
}

function creditState(original: StoredInvoiceLine[], context: RectificationContext): CreditState {
  const lines = new Map<string, Remaining>(
    original.map((line) => [
      line.id,
      { line, quantity: Number(line.quantity), taxCents: line.taxCents, totalCents: line.totalCents, credited: false },
    ]),
  );
  const sign = Math.sign(context.invoiceTotalCents ?? 0);
  let linkedCents = 0;
  let unlinkedCents = 0;
  for (const p of context.prior ?? []) {
    const r = p.rectifiesLineId ? lines.get(p.rectifiesLineId) : undefined;
    if (p.rectifiesLineId && !r) continue; // a line of another invoice: not a credit of this one
    if (r) {
      const q = Number(p.quantity);
      // Units given back have the opposite sign; a credit by amount keeps the quantity.
      if (Math.sign(q) === -Math.sign(Number(r.line.quantity))) r.quantity += q;
      r.taxCents += p.taxCents;
      r.totalCents += p.totalCents;
      r.credited = true;
      linkedCents += p.totalCents;
    } else if (sign !== 0 && Math.sign(p.totalCents) === -sign) {
      unlinkedCents += p.totalCents;
    }
  }
  return {
    lines,
    sign,
    unlinkedCents,
    invoiceLeftCents:
      context.invoiceTotalCents === undefined ? undefined : context.invoiceTotalCents + linkedCents + unlinkedCents,
  };
}

/** Everything left: each line's remaining amounts, less its share of the credits not tied to a line. */
function wholeRemaining(state: CreditState): InvoiceLineInput[] {
  let open = [...state.lines.values()].filter((r) => !r.credited || r.totalCents !== 0 || r.taxCents !== 0);
  let shares = open.map(() => 0);
  const sign = state.sign || 1;
  if (state.unlinkedCents !== 0) {
    const weights = open.map((r) => sign * r.totalCents);
    const absorb = Math.abs(state.unlinkedCents);
    if (absorb >= weights.reduce((s, w) => s + Math.max(0, w), 0)) open = [];
    else shares = allocateCents(absorb, weights);
  }
  const lines = open.flatMap((r, i) => {
    if (shares[i] === 0) return [creditOf(r, r.taxCents, r.totalCents, 0 - r.quantity)];
    const totalCents = r.totalCents - sign * shares[i];
    if (totalCents === 0) return [];
    const taxCents = Math.round((r.taxCents * totalCents) / r.totalCents);
    return [creditOf(r, taxCents, totalCents, 0 - r.quantity)];
  });
  if (lines.length === 0) {
    throw new BadRequestException("La factura ya está abonada entera: no queda nada que rectificar");
  }
  return lines;
}

function quantityCredit(r: Remaining, requested: number | undefined): InvoiceLineInput {
  const { line } = r;
  if (r.credited && r.totalCents === 0 && r.taxCents === 0) {
    throw new BadRequestException(`La línea "${line.description}" ya está abonada entera`);
  }
  const quantity = Number(requested);
  const ratio = r.quantity !== 0 ? quantity / r.quantity : NaN;
  // A credit: the opposite sign of what is left, at most all of it.
  if (!Number.isFinite(ratio) || ratio >= 0 || ratio < -1 - EPSILON) {
    const range = `La línea "${line.description}" solo se puede abonar: entre ${units(-r.quantity)} y 0 unidades, sin llegar a 0`;
    throw new BadRequestException(
      r.credited ? `${range} (el resto ya está abonado en otra rectificativa)` : range,
    );
  }
  const share = Math.min(1, -ratio);
  if (share >= 1 - EPSILON) return creditOf(r, r.taxCents, r.totalCents, 0 - r.quantity);

  const taxRate = Number(line.taxRate);
  let taxCents: number;
  let totalCents: number;
  if (line.taxIncluded === true) {
    totalCents = Math.round(r.totalCents * share);
    const base = Math.round(totalCents / (1 + taxRate / 100));
    taxCents = totalCents - base;
  } else {
    const base = Math.round((r.totalCents - r.taxCents) * share);
    taxCents = Math.round(base * (taxRate / 100));
    totalCents = base + taxCents;
  }
  return creditOf(r, taxCents, totalCents, quantity);
}

/** `amountCents` of the line's price, in its own terms, credited as one line of 1 x a negative price. */
function amountCredit(r: Remaining, amountCents: number): InvoiceLineInput {
  assertCents(amountCents);
  const { line } = r;
  if (!positiveLine(line)) {
    throw new BadRequestException(`La línea "${line.description}" no admite un abono por importe`);
  }
  const left = priceLeft(r);
  if (left <= 0) throw new BadRequestException(`La línea "${line.description}" ya está abonada entera`);
  if (amountCents > left) {
    throw new BadRequestException(
      `El abono (${euros(amountCents)}) supera lo que queda por abonar de la línea "${line.description}" (${euros(left)})`,
    );
  }
  const taxRate = Number(line.taxRate);
  let taxCents: number;
  let totalCents: number;
  if (amountCents === left) {
    taxCents = r.taxCents;
    totalCents = r.totalCents;
  } else if (line.taxIncluded === true) {
    totalCents = amountCents;
    taxCents = totalCents - Math.round(totalCents / (1 + taxRate / 100));
  } else {
    // The base, and its tax: never more tax than is left on the line.
    taxCents = Math.min(Math.round(amountCents * (taxRate / 100)), r.taxCents);
    totalCents = amountCents + taxCents;
  }
  return {
    ...creditOf(r, taxCents, totalCents, 1, false),
    description: `Descuento: ${line.description}`,
    unitPriceCents: 0 - (totalCents - taxCents),
    discountPct: 0,
  };
}

/**
 * `taxCents` / `totalCents` of a line (in the original's sign), credited:
 * the opposite sign, linked to the line, and taken off what is left of it so
 * a later line of the same request sees only the rest.
 */
function creditOf(
  r: Remaining,
  taxCents: number,
  totalCents: number,
  quantity: number,
  givesUnitsBack = true,
): InvoiceLineInput {
  const { line } = r;
  if (givesUnitsBack) r.quantity += quantity;
  r.taxCents -= taxCents;
  r.totalCents -= totalCents;
  r.credited = true;
  return {
    description: line.description,
    quantity,
    unitPriceCents: line.unitPriceCents,
    discountPct: Number(line.discountPct ?? 0),
    taxRate: Number(line.taxRate),
    taxIncluded: line.taxIncluded === true,
    productId: line.productId ?? undefined,
    serviceId: line.serviceId ?? undefined,
    rectifiesLineId: line.id,
    // Negating 0 gives -0; keep a plain 0.
    fixed: { taxCents: 0 - taxCents, totalCents: 0 - totalCents },
  };
}

/** 400 when the rectificativa would take the invoice past zero (credits not tied to a line included). */
function assertWithinInvoice(state: CreditState, lines: InvoiceLineInput[]): void {
  if (state.invoiceLeftCents === undefined || state.sign === 0) return;
  const { sign } = state;
  const credited = lines
    .map((l) => l.fixed?.totalCents ?? new InvoiceCalculator().compute([l]).totalCents)
    .filter((cents) => Math.sign(cents) === -sign)
    .reduce((s, cents) => s - sign * cents, 0);
  const left = sign * state.invoiceLeftCents;
  if (credited > left) {
    throw new BadRequestException(
      left <= 0
        ? "La factura ya está abonada entera: no queda nada que rectificar"
        : `La rectificativa abonaría ${euros(credited)}, pero de esta factura solo quedan ${euros(left)} por abonar: lo ya abonado en otras rectificativas no se puede volver a abonar`,
    );
  }
}

/** What is left of the line's price in its own terms: the total with the tax included, else the base. */
function priceLeft(r: Remaining): number {
  return r.line.taxIncluded === true ? r.totalCents : r.totalCents - r.taxCents;
}

function positiveLine(line: StoredInvoiceLine): boolean {
  return Number(line.quantity) > 0 && line.totalCents > 0;
}

function assertCents(amountCents: number): void {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new BadRequestException("El importe a abonar va en céntimos enteros, mayor que 0");
  }
}

function units(quantity: number): string {
  return String(Math.round(quantity * 1000) / 1000);
}

function euros(cents: number): string {
  return (cents / 100).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + " €";
}

function freeLine(req: RectificationLineRequest): InvoiceLineInput {
  if (
    typeof req.description !== "string" ||
    typeof req.quantity !== "number" ||
    typeof req.unitPriceCents !== "number" ||
    typeof req.taxRate !== "number"
  ) {
    throw new BadRequestException(
      "Cada línea necesita originalLineId, o descripción, cantidad, precio unitario y tipo de impuesto",
    );
  }
  return {
    description: req.description,
    quantity: req.quantity,
    unitPriceCents: req.unitPriceCents,
    discountPct: req.discountPct,
    taxRate: req.taxRate,
  };
}
