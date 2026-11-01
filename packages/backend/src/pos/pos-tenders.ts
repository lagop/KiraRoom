import { BadRequestException } from '@nestjs/common';

export interface Tender {
  method: string;
  amount: number;
  /** For a gift card: the code the client shows (redeemed in the sale's transaction). */
  giftCardCode?: string;
}

/**
 * What the till records of what the client handed over, in cents (money:
 * tax included, appointment-charge.ts).
 *
 * The till took any amount at or above the total and recorded all of it as
 * revenue: 100 € "paid" by card on a 40 € ticket was 100 € of sales. Now:
 *
 * - a card, transfer, Bizum, wallet or gift card payment is exactly what it
 *   pays: nothing over the total is accepted from them;
 * - cash may be more than the total: the difference is the change given
 *   back (`change`), taken off the cash tenders, so only the total is
 *   recorded;
 * - several methods together (cash + card...) must add up to the total, the
 *   excess only from cash;
 * - a gift card needs its code: the sale redeems that much from it
 *   (GiftCardsService.redeemInTx) in its own transaction.
 */
export function settleTenders(tenders: Tender[], totalCents: number): { tenders: Tender[]; change: number } {
  for (const t of tenders) {
    if (t.method === 'gift_card' && !t.giftCardCode?.trim()) {
      throw new BadRequestException('Escribe el código de la tarjeta regalo con la que paga la clienta.');
    }
    if (t.method === 'loyalty_points') {
      throw new BadRequestException('Los puntos se canjean eligiendo una recompensa, no como forma de pago.');
    }
  }
  const paid = tenders.reduce((sum, t) => sum + t.amount, 0);
  if (paid < totalCents) {
    throw new BadRequestException('El importe cobrado es menor que el total del ticket.');
  }
  const excess = paid - totalCents;
  if (excess === 0) return { tenders, change: 0 };

  const cash = tenders.filter((t) => t.method === 'cash').reduce((sum, t) => sum + t.amount, 0);
  if (excess > cash) {
    throw new BadRequestException(
      'Con tarjeta, transferencia, Bizum, cartera o tarjeta regalo se cobra exactamente lo que falta: solo el efectivo puede ser mayor (se devuelve el cambio).',
    );
  }

  // The change comes out of the cash, last cash tender first.
  let left = excess;
  const settled = [...tenders];
  for (let i = settled.length - 1; i >= 0 && left > 0; i--) {
    if (settled[i].method !== 'cash') continue;
    const take = Math.min(left, settled[i].amount);
    settled[i] = { ...settled[i], amount: settled[i].amount - take };
    left -= take;
  }
  // A cash tender that was all change records nothing; a ticket that cost
  // nothing still records its (zero) tender, as before.
  const kept = settled.filter((t) => t.amount > 0);
  return { tenders: kept.length > 0 ? kept : settled.slice(0, 1), change: excess };
}
