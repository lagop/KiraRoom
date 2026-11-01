import { BadRequestException } from '@nestjs/common';

export interface Tender {
  method: string;
  amount: number;
}

/**
 * What the till records of what the client handed over, in cents.
 *
 * The till took any amount at or above the total and recorded all of it as
 * revenue: 100 € "paid" by card on a 40 € ticket was 100 € of sales. Now:
 *
 * - a card, transfer or wallet payment is exactly what it pays: nothing
 *   over the total is accepted from them;
 * - cash may be more than the total: the difference is the change given
 *   back (`change`), taken off the cash tenders, so only the total is
 *   recorded;
 * - a gift card is not a plain method: there is no card behind it at the
 *   till (gift cards are redeemed in Tarjetas regalo), so it is refused.
 */
export function settleTenders(tenders: Tender[], totalCents: number): { tenders: Tender[]; change: number } {
  if (tenders.some((t) => t.method === 'gift_card')) {
    throw new BadRequestException(
      'Las tarjetas regalo se canjean desde Tarjetas regalo. En la caja cobra en efectivo, con tarjeta, por transferencia o con la cartera de la clienta.',
    );
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
      'Con tarjeta, transferencia o cartera se cobra exactamente el total del ticket: solo el efectivo puede ser mayor (se devuelve el cambio).',
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
