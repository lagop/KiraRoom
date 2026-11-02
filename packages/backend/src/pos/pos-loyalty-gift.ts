import { BadRequestException } from '@nestjs/common';
import type { RewardGift } from '../loyalty/loyalty.service';
import type { SimplifiedInvoiceLine } from '../invoices/invoices.service';
import { productTaxRatePercent } from '../invoices/salon-tax-settings';

/**
 * A loyalty reward handed over at the desk (audit L11): a product of the
 * catalogue or "otro regalo". Redeeming one used to leave no trace but the
 * points: no line on the ticket and, for a product, stock that no longer
 * matched the shelf. Now the sale gets a zero-price line ("regalo
 * fidelidad") and a product leaves the stock with its movement.
 *
 * IVA: a gift may be "autoconsumo" (taxed on its cost, art. 9 LIVA). How
 * the salon treats it is pending its gestor; until then the line is at
 * zero, so it adds nothing to the invoice's taxes.
 */

/** The line kind of a reward handed over (PosSaleLine.kind). */
export const LOYALTY_GIFT_KIND = 'loyalty_gift';
/** The stock movement's reason. */
export const LOYALTY_GIFT_REASON = 'regalo fidelidad';
/** The movement's reason when the whole sale is given back and the gift returns to stock. */
export const LOYALTY_GIFT_RETURN_REASON = 'devolución regalo fidelidad';

export interface GiftLine {
  /** The product handed over (its stock goes down), or null ("otro regalo"). */
  productId: string | null;
  trackInventory: boolean;
  /** "Regalo fidelidad: Champú reparador". */
  description: string;
  /** The product's rate, else the salon's: only so the invoice line has one (its amount is 0). */
  taxRate: number;
}

type Db = { product: { findFirst: (args: any) => Promise<any> } };

/** The line of a reward's gift. A product no longer in the catalogue is recorded as "otro regalo". */
export async function giftLineOf(
  db: Db,
  tenantId: string,
  gift: RewardGift,
  salonRatePercent: number,
): Promise<GiftLine> {
  if (gift.kind === 'product' && gift.productId) {
    const product = await db.product.findFirst({
      where: { id: gift.productId, tenantId },
      select: { id: true, name: true, taxRate: true, trackInventory: true },
    });
    if (product) {
      return {
        productId: product.id,
        trackInventory: !!product.trackInventory,
        description: `Regalo fidelidad: ${product.name}`.slice(0, 200),
        taxRate: productTaxRatePercent(product.taxRate, salonRatePercent),
      };
    }
  }
  return {
    productId: null,
    trackInventory: false,
    description: `Regalo fidelidad: ${gift.description}`.slice(0, 200),
    taxRate: salonRatePercent,
  };
}

/**
 * Inside the sale's transaction: one unit of the product out of stock,
 * never below zero (like a sale: the till cannot give what is not there),
 * with its inventory movement. Nothing for "otro regalo" or a product
 * whose stock is not counted.
 */
export async function takeGiftFromStock(tx: any, tenantId: string, line: GiftLine, saleId: string): Promise<void> {
  if (!line.productId || !line.trackInventory) return;
  const { count } = await tx.product.updateMany({
    where: { id: line.productId, tenantId, trackInventory: true, quantity: { gte: 1 } },
    data: { quantity: { decrement: 1 } },
  });
  const after = await tx.product.findFirst({
    where: { id: line.productId, tenantId },
    select: { quantity: true, trackInventory: true },
  });
  if (count !== 1) {
    if (!after?.trackInventory) return;
    throw new BadRequestException(
      `No queda stock de ${line.description.replace(/^Regalo fidelidad: /, '')} para el regalo de fidelidad: elige otra recompensa o repón el producto.`,
    );
  }
  await tx.inventoryTransaction.create({
    data: {
      productId: line.productId,
      tenantId,
      type: 'adjustment',
      quantity: -1,
      previousQty: (after?.quantity ?? 0) + 1,
      newQty: after?.quantity ?? 0,
      reason: LOYALTY_GIFT_REASON,
      notes: `Venta ${saleId}`,
    },
  });
}

/**
 * Inside a refund's transaction, when the WHOLE till sale has been given
 * back (no payment of it left paid: the same condition under which the
 * points spent on the reward come back, LoyaltyService.onPaymentRefunded),
 * the gift's product returns to stock: +1 with a "devolución regalo
 * fidelidad" movement.
 *
 * Exactly once: the gift line's refundedQuantity is set over what was just
 * read, so a retry or a concurrent refund finds it set and does nothing.
 * Only when the sale really took the unit out (its "regalo fidelidad"
 * movement exists) and the product's stock is still counted; "otro regalo"
 * never moved stock. Returns the units put back.
 */
export async function returnGiftIfSaleRefundedIn(tx: any, tenantId: string, saleId: string): Promise<number> {
  const stillPaid = await tx.payment.count({
    where: { tenantId, status: 'paid', metadata: { path: ['posSaleId'], equals: saleId } },
  });
  if (stillPaid > 0) return 0;
  const lines = await tx.posSaleLine.findMany({
    where: { tenantId, saleId, kind: LOYALTY_GIFT_KIND },
    select: { id: true, productId: true, quantity: true, refundedQuantity: true },
  });
  let back = 0;
  for (const line of lines) {
    const before = line.refundedQuantity ?? 0;
    const left = line.quantity - before;
    if (left <= 0) continue;
    const { count } = await tx.posSaleLine.updateMany({
      where: { id: line.id, tenantId, refundedQuantity: before },
      data: { refundedQuantity: line.quantity },
    });
    if (count !== 1 || !line.productId) continue;
    const taken = await tx.inventoryTransaction.findFirst({
      where: { tenantId, productId: line.productId, reason: LOYALTY_GIFT_REASON, notes: `Venta ${saleId}` },
      select: { id: true },
    });
    if (!taken) continue;
    const { count: moved } = await tx.product.updateMany({
      where: { id: line.productId, tenantId, trackInventory: true },
      data: { quantity: { increment: left } },
    });
    if (moved !== 1) continue;
    const after = await tx.product.findFirst({ where: { id: line.productId, tenantId }, select: { quantity: true } });
    const newQty = after?.quantity ?? left;
    await tx.inventoryTransaction.create({
      data: {
        productId: line.productId,
        tenantId,
        type: 'adjustment',
        quantity: left,
        previousQty: newQty - left,
        newQty,
        reason: LOYALTY_GIFT_RETURN_REASON,
        notes: `Venta ${saleId}`,
      },
    });
    back += left;
  }
  return back;
}

/** The sale's zero-price line of the gift (PosSaleLine). */
export function giftSaleLine(line: GiftLine, saleId: string, tenantId: string, lineIndex: number) {
  return {
    saleId,
    tenantId,
    lineIndex,
    kind: LOYALTY_GIFT_KIND,
    productId: line.productId,
    description: line.description,
    quantity: 1,
    unitPriceCents: 0,
    discountCents: 0,
    totalCents: 0,
    taxRate: line.taxRate,
    taxCents: 0,
    commissionBaseCents: 0,
  };
}

/**
 * The gift on the sale's own invoice, as a zero line (owner: "a zero line
 * is fine"), when the invoice already has a line at its rate: a zero line
 * at a rate of its own would add an empty tax bucket to the fiscal record
 * (VeriFactu / SII). IVA treatment (autoconsumo) pending the salon's gestor.
 */
export function giftInvoiceLine(line: GiftLine, invoiceLines: SimplifiedInvoiceLine[]): SimplifiedInvoiceLine | null {
  if (!invoiceLines.some((l) => Number(l.taxRate) === Number(line.taxRate))) return null;
  return {
    description: line.description,
    quantity: 1,
    unitPriceCents: 0,
    taxRate: line.taxRate,
    taxIncluded: true,
    ...(line.productId ? { productId: line.productId } : {}),
  };
}
