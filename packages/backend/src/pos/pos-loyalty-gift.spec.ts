import { BadRequestException } from '@nestjs/common';
import {
  giftInvoiceLine,
  giftLineOf,
  giftSaleLine,
  returnGiftIfSaleRefundedIn,
  takeGiftFromStock,
  LOYALTY_GIFT_KIND,
  LOYALTY_GIFT_RETURN_REASON,
} from './pos-loyalty-gift';

/**
 * A loyalty reward handed over at the till (audit L11): a zero-price line
 * and, for a product, one unit out of stock ("regalo fidelidad").
 */
describe('pos-loyalty-gift', () => {
  const productDb = (product: any) => ({ product: { findFirst: jest.fn(async () => product) } });

  it('a product reward: the product, its rate, its stock counted', async () => {
    const line = await giftLineOf(
      productDb({ id: 'p1', name: 'Champú', taxRate: 0.1, trackInventory: true }),
      't1',
      { kind: 'product', productId: 'p1', description: 'Champú' },
      21,
    );
    expect(line).toEqual({ productId: 'p1', trackInventory: true, description: 'Regalo fidelidad: Champú', taxRate: 10 });
  });

  it('«otro regalo», or a product gone from the catalogue: the description, the salon rate, no stock', async () => {
    const other = await giftLineOf(productDb(null), 't1', { kind: 'other', productId: null, description: 'Neceser' }, 21);
    expect(other).toEqual({ productId: null, trackInventory: false, description: 'Regalo fidelidad: Neceser', taxRate: 21 });
    const gone = await giftLineOf(productDb(null), 't1', { kind: 'product', productId: 'p9', description: 'Champú' }, 21);
    expect(gone.productId).toBeNull();
  });

  it('the sale line is zero-price, of its own kind', () => {
    const line = { productId: 'p1', trackInventory: true, description: 'Regalo fidelidad: Champú', taxRate: 21 };
    expect(giftSaleLine(line, 's1', 't1', 3)).toMatchObject({
      kind: LOYALTY_GIFT_KIND,
      lineIndex: 3,
      productId: 'p1',
      unitPriceCents: 0,
      totalCents: 0,
      taxCents: 0,
      commissionBaseCents: 0,
    });
  });

  it('on the invoice as a zero line only beside a line of the same rate (no empty tax bucket)', () => {
    const line = { productId: null, trackInventory: false, description: 'Regalo fidelidad: Neceser', taxRate: 21 };
    const at21 = [{ description: 'Mascarilla', quantity: 1, unitPriceCents: 1200, taxRate: 21 }];
    expect(giftInvoiceLine(line, at21)).toEqual({
      description: 'Regalo fidelidad: Neceser',
      quantity: 1,
      unitPriceCents: 0,
      taxRate: 21,
      taxIncluded: true,
    });
    expect(giftInvoiceLine(line, [{ ...at21[0], taxRate: 10 }])).toBeNull();
    expect(giftInvoiceLine(line, [])).toBeNull();
  });

  it('takes one unit out of stock with a «regalo fidelidad» movement, and refuses when there is none', async () => {
    const tx: any = {
      product: {
        updateMany: jest.fn(async () => ({ count: 1 })),
        findFirst: jest.fn(async () => ({ quantity: 3, trackInventory: true })),
      },
      inventoryTransaction: { create: jest.fn(async () => ({})) },
    };
    const line = { productId: 'p1', trackInventory: true, description: 'Regalo fidelidad: Champú', taxRate: 21 };
    await takeGiftFromStock(tx, 't1', line, 's1');
    expect(tx.inventoryTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ productId: 'p1', quantity: -1, previousQty: 4, newQty: 3, reason: 'regalo fidelidad' }),
    });

    tx.product.updateMany.mockResolvedValueOnce({ count: 0 });
    tx.product.findFirst.mockResolvedValueOnce({ quantity: 0, trackInventory: true });
    await expect(takeGiftFromStock(tx, 't1', line, 's2')).rejects.toBeInstanceOf(BadRequestException);

    // «otro regalo»: nothing to move.
    tx.product.updateMany.mockClear();
    await takeGiftFromStock(tx, 't1', { ...line, productId: null, trackInventory: false }, 's3');
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });
});

describe('returnGiftIfSaleRefundedIn (the whole sale given back)', () => {
  const makeTx = (over: { stillPaid?: number; lines?: any[]; taken?: any; tracked?: boolean } = {}) => {
    const lines = over.lines ?? [{ id: 'g1', productId: 'p1', quantity: 1, refundedQuantity: 0 }];
    return {
      payment: { count: jest.fn(async () => over.stillPaid ?? 0) },
      posSaleLine: {
        findMany: jest.fn(async () => lines),
        updateMany: jest.fn(async ({ where }: any) => {
          const l = lines.find((x) => x.id === where.id);
          if (!l || l.refundedQuantity !== where.refundedQuantity) return { count: 0 };
          return { count: 1 };
        }),
      },
      inventoryTransaction: {
        findFirst: jest.fn(async () => ('taken' in over ? over.taken : { id: 'm1' })),
        create: jest.fn(async () => ({})),
      },
      product: {
        updateMany: jest.fn(async () => ({ count: over.tracked === false ? 0 : 1 })),
        findFirst: jest.fn(async () => ({ quantity: 5 })),
      },
    } as any;
  };

  it('puts the unit back with a «devolución regalo fidelidad» movement', async () => {
    const tx = makeTx();
    expect(await returnGiftIfSaleRefundedIn(tx, 't1', 's1')).toBe(1);
    expect(tx.posSaleLine.updateMany).toHaveBeenCalledWith({
      where: { id: 'g1', tenantId: 't1', refundedQuantity: 0 },
      data: { refundedQuantity: 1 },
    });
    expect(tx.product.updateMany).toHaveBeenCalledWith({
      where: { id: 'p1', tenantId: 't1', trackInventory: true },
      data: { quantity: { increment: 1 } },
    });
    expect(tx.inventoryTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: 'p1',
        tenantId: 't1',
        type: 'adjustment',
        quantity: 1,
        previousQty: 4,
        newQty: 5,
        reason: LOYALTY_GIFT_RETURN_REASON,
        notes: 'Venta s1',
      }),
    });
    expect(LOYALTY_GIFT_RETURN_REASON).toBe('devolución regalo fidelidad');
  });

  it('nothing while a payment of the sale is still paid (a partial or first-of-two refund)', async () => {
    const tx = makeTx({ stillPaid: 1 });
    expect(await returnGiftIfSaleRefundedIn(tx, 't1', 's1')).toBe(0);
    expect(tx.posSaleLine.findMany).not.toHaveBeenCalled();
    expect(tx.product.updateMany).not.toHaveBeenCalled();
  });

  it('exactly once: a gift line already given back, or claimed by a concurrent refund, moves nothing', async () => {
    const done = makeTx({ lines: [{ id: 'g1', productId: 'p1', quantity: 1, refundedQuantity: 1 }] });
    expect(await returnGiftIfSaleRefundedIn(done, 't1', 's1')).toBe(0);
    expect(done.posSaleLine.updateMany).not.toHaveBeenCalled();

    const raced = makeTx();
    raced.posSaleLine.updateMany.mockResolvedValueOnce({ count: 0 });
    expect(await returnGiftIfSaleRefundedIn(raced, 't1', 's1')).toBe(0);
    expect(raced.product.updateMany).not.toHaveBeenCalled();
    expect(raced.inventoryTransaction.create).not.toHaveBeenCalled();
  });

  it('«otro regalo», a gift that never left the stock, or a product no longer counted: the line is closed, no stock moves', async () => {
    const other = makeTx({ lines: [{ id: 'g1', productId: null, quantity: 1, refundedQuantity: 0 }] });
    expect(await returnGiftIfSaleRefundedIn(other, 't1', 's1')).toBe(0);
    expect(other.posSaleLine.updateMany).toHaveBeenCalled();
    expect(other.product.updateMany).not.toHaveBeenCalled();

    const untracked = makeTx({ taken: null });
    expect(await returnGiftIfSaleRefundedIn(untracked, 't1', 's1')).toBe(0);
    expect(untracked.product.updateMany).not.toHaveBeenCalled();

    const notCounted = makeTx({ tracked: false });
    expect(await returnGiftIfSaleRefundedIn(notCounted, 't1', 's1')).toBe(0);
    expect(notCounted.inventoryTransaction.create).not.toHaveBeenCalled();
  });
});
