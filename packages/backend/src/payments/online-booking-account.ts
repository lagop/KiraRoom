/**
 * The connected Stripe account a payment made when booking online was taken
 * on (OnlineBookingPaymentService.complete records it in the payment's
 * metadata), or null for any other payment: its refund is not ours to make
 * on Stripe. In its own file so payments and appointments can both use it
 * without importing each other.
 */
export function onlineBookingAccountOf(payment: { metadata?: unknown }): string | null {
  const m = (payment.metadata ?? {}) as { online?: unknown; stripeAccount?: unknown };
  return m.online === true && typeof m.stripeAccount === 'string' && m.stripeAccount ? m.stripeAccount : null;
}
