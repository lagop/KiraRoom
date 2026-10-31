import { BadRequestException } from "@nestjs/common";
import type { InvoiceLineInput } from "./invoice-calculator.service";

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
 * Lines that credit a line of the original (`originalLineId`):
 *   the whole quantity -> the stored amounts, negated, exactly;
 *   part of it         -> that share of the stored line, split the way the
 *                         original was: with the tax included, the share of
 *                         the total is split into base + tax; with the tax
 *                         on top, the share of the base gets its tax. The
 *                         share is worked out on the positive amounts and
 *                         then negated, so it rounds like the original did.
 * No lines at all: every line of the original, whole (a full rectification).
 * Lines without `originalLineId` are free lines (a "por diferencias" amount),
 * computed as given with the tax on top, as before.
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
  /** Negative to credit. With originalLineId: minus the original quantity, or part of it. */
  quantity: number;
  unitPriceCents?: number;
  discountPct?: number;
  taxRate?: number;
}

const EPSILON = 1e-9;

export function rectificationLines(
  original: StoredInvoiceLine[],
  requested?: RectificationLineRequest[] | null,
): InvoiceLineInput[] {
  if (!requested || requested.length === 0) {
    if (original.length === 0) {
      throw new BadRequestException("La factura original no tiene líneas que rectificar");
    }
    return original.map((line) => creditedLine(line, 1));
  }

  const credited = new Map<string, number>();
  return requested.map((req) => {
    if (req.originalLineId === undefined || req.originalLineId === null) return freeLine(req);

    const line = original.find((l) => l.id === req.originalLineId);
    if (!line) {
      throw new BadRequestException(`La línea ${req.originalLineId} no es de la factura que se rectifica`);
    }
    const originalQuantity = Number(line.quantity);
    const ratio = originalQuantity !== 0 ? req.quantity / originalQuantity : NaN;
    // A credit: the opposite sign of the original, at most all of it.
    if (!Number.isFinite(ratio) || ratio >= 0 || ratio < -1 - EPSILON) {
      throw new BadRequestException(
        `La línea "${line.description}" solo se puede abonar: entre ${-originalQuantity} y 0 unidades, sin llegar a 0`,
      );
    }
    const share = Math.min(1, -ratio);
    const total = (credited.get(line.id) ?? 0) + share;
    if (total > 1 + EPSILON) {
      throw new BadRequestException(`La línea "${line.description}" se abona más de una vez entera`);
    }
    credited.set(line.id, total);
    return creditedLine(line, share, req.quantity);
  });
}

/**
 * `share` (0-1] of a stored line, credited: the opposite sign of the
 * original. `quantity` is the one asked for; a whole line takes the
 * original's, negated.
 */
function creditedLine(line: StoredInvoiceLine, share: number, quantity?: number): InvoiceLineInput {
  const taxRate = Number(line.taxRate);
  const taxIncluded = line.taxIncluded === true;
  let taxCents: number;
  let totalCents: number;
  if (share >= 1 - EPSILON) {
    taxCents = line.taxCents;
    totalCents = line.totalCents;
  } else if (taxIncluded) {
    totalCents = Math.round(line.totalCents * share);
    const base = Math.round(totalCents / (1 + taxRate / 100));
    taxCents = totalCents - base;
  } else {
    const base = Math.round((line.totalCents - line.taxCents) * share);
    taxCents = Math.round(base * (taxRate / 100));
    totalCents = base + taxCents;
  }
  return {
    description: line.description,
    quantity: share >= 1 - EPSILON || quantity === undefined ? 0 - Number(line.quantity) : quantity,
    unitPriceCents: line.unitPriceCents,
    discountPct: Number(line.discountPct ?? 0),
    taxRate,
    taxIncluded,
    productId: line.productId ?? undefined,
    serviceId: line.serviceId ?? undefined,
    // Negating 0 gives -0; keep a plain 0.
    fixed: { taxCents: 0 - taxCents, totalCents: 0 - totalCents },
  };
}

function freeLine(req: RectificationLineRequest): InvoiceLineInput {
  if (
    typeof req.description !== "string" ||
    typeof req.unitPriceCents !== "number" ||
    typeof req.taxRate !== "number"
  ) {
    throw new BadRequestException(
      "Cada línea necesita originalLineId, o descripción, precio unitario y tipo de impuesto",
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
