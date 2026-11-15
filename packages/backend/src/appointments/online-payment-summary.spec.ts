import { onlinePaymentSummary } from './online-payment-summary';

const ONLINE = { online: true, stripeAccount: 'acct_1' };
const at = (iso: string) => new Date(iso);

describe('onlinePaymentSummary (the file of a booking paid online)', () => {
  it('a señal paid and given back on cancelling', () => {
    expect(
      onlinePaymentSummary([
        {
          amount: 500,
          status: 'refunded',
          metadata: ONLINE,
          refunds: [{ amount: 500, status: 'succeeded', createdAt: at('2026-11-15T11:00:00Z') }],
        },
      ]),
    ).toEqual({ paidCents: 500, refundedCents: 500, refundPendingCents: 0, refundFailed: false, refundedAt: '2026-11-15T11:00:00.000Z' });
  });

  it('still paid, nothing asked back', () => {
    expect(onlinePaymentSummary([{ amount: 5445, status: 'paid', metadata: ONLINE, refunds: [] }])).toMatchObject({
      paidCents: 5445,
      refundedCents: 0,
      refundedAt: null,
    });
  });

  it('a refund Stripe refused is flagged, one pending is counted', () => {
    expect(
      onlinePaymentSummary([
        { amount: 5445, status: 'paid', metadata: ONLINE, refunds: [{ amount: 5445, status: 'failed', createdAt: at('2026-11-15T11:00:00Z') }] },
      ])?.refundFailed,
    ).toBe(true);
    expect(
      onlinePaymentSummary([
        { amount: 500, status: 'paid', metadata: ONLINE, refunds: [{ amount: 500, status: 'pending', createdAt: at('2026-11-15T11:00:00Z') }] },
      ])?.refundPendingCents,
    ).toBe(500);
  });

  it('ignores payments taken at the till and unfinished ones', () => {
    expect(onlinePaymentSummary([{ amount: 3000, status: 'paid', metadata: {}, refunds: [] }])).toBeNull();
    expect(onlinePaymentSummary([{ amount: 500, status: 'pending', metadata: ONLINE, refunds: [] }])).toBeNull();
    expect(onlinePaymentSummary([])).toBeNull();
  });
});
