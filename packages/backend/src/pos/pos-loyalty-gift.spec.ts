import { BadRequestException } from '@nestjs/common';
import { giftInvoiceLine, giftLineOf, giftSaleLine, takeGiftFromStock, LOYALTY_GIFT_KIND } from './pos-loyalty-gift';

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
