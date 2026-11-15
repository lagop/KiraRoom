import { onlineBookingAccountOf } from '../payments/online-booking-account';

/**
 * What a booking paid online and what went back, for the appointment's
 * file in the panel. A cancellation refunds the payment and sets
 * amountPaid back to 0, so the file said nothing at all about the señal or
 * the prepayment the client had paid, nor that it was returned.
 */
export interface OnlinePaymentSummary {
  /** Cents the client paid online (señal or the whole visit). */
  paidCents: number;
  /** Cents Stripe has given back. */
  refundedCents: number;
  /** Cents asked back and not confirmed yet. */
  refundPendingCents: number;
  /** A refund Stripe refused: the salon has to give it back from Pagos. */
  refundFailed: boolean;
  /** When the last refund was made (ISO), or null. */
  refundedAt: string | null;
}

type PaymentRow = {
  amount: number;
  status: string;
  metadata?: unknown;
  refunds: Array<{ amount: number; status: string; createdAt: Date }>;
};

export function onlinePaymentSummary(payments: PaymentRow[]): OnlinePaymentSummary | null {
  const online = payments.filter((p) => onlineBookingAccountOf(p) && (p.status === 'paid' || p.status === 'refunded'));
  if (online.length === 0) return null;
  const refunds = online.flatMap((p) => p.refunds);
  const sum = (rows: Array<{ amount: number }>) => rows.reduce((s, r) => s + Math.max(0, Math.round(r.amount)), 0);
  const done = refunds.filter((r) => r.status === 'succeeded');
  const last = done.reduce<Date | null>((d, r) => (!d || r.createdAt > d ? r.createdAt : d), null);
  return {
    paidCents: sum(online),
    refundedCents: sum(done),
    refundPendingCents: sum(refunds.filter((r) => r.status === 'pending' || r.status === 'processing')),
    refundFailed: refunds.some((r) => r.status === 'failed') && done.length === 0,
    refundedAt: last ? last.toISOString() : null,
  };
}
