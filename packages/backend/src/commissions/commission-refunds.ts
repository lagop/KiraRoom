/**
 * Refunds and commissions: what was given back no longer earns a commission.
 *
 * Where each commission lives, and so where the refund is taken off:
 *
 *   - A walk-in service sold at the till: a stored row (PosSaleLine) with
 *     its base, rate and amount worked out when it was sold. A refund of
 *     the sale records on the line what was given back of it
 *     (refundedCents, payments/refund-lines.ts); the commission counts what
 *     is left: amount x (totalCents - refundedCents) / totalCents. A line
 *     refunded in full earns nothing.
 *   - An appointment: computed on the fly from the visit (its total x the
 *     rate, or the amount stored on it). Its refunds are the refunds of its
 *     payments, so its commission is scaled by the share of what was paid
 *     for it that the salon kept: (paid - refunded) / paid. A visit refunded
 *     in full (paymentStatus refunded) earns nothing; one never paid with
 *     money (all points) keeps its commission as before.
 *
 * The loyalty reward is not a refund: it is paid with points and does not
 * lower a commission (the visit's total, the line's base stay as they are).
 */

/** The share kept of what was charged, 0..1 (1 when nothing was charged in money). */
export function keptShare(chargedCents: number, refundedCents: number): number {
  if (!(chargedCents > 0)) return 1;
  return Math.min(1, Math.max(0, (chargedCents - Math.max(0, refundedCents)) / chargedCents));
}

/** Two decimals, as commissions are shown and stored (Decimal(12, 2)). */
export function roundCommission(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A till sale line's commission figures after its refunds. */
export function saleLineAfterRefunds(line: {
  commissionBaseCents: number;
  commissionAmount: number;
  totalCents: number;
  refundedCents?: number | null;
}): { baseCents: number; commission: number; kept: number } {
  const kept = keptShare(line.totalCents, line.refundedCents ?? 0);
  return {
    baseCents: Math.round(line.commissionBaseCents * kept),
    commission: roundCommission(line.commissionAmount * kept),
    kept,
  };
}

/** The part of Prisma this needs. */
interface PaymentsReader {
  payment?: { findMany?: (args: any) => Promise<any[]> };
}

/**
 * Per appointment, the share of what was paid for it in money that the
 * salon kept after its refunds (keptShare), for the appointments that had a
 * refund; the others are left out (1).
 */
export async function appointmentKeptShares(
  db: PaymentsReader,
  tenantId: string,
  appointmentIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (appointmentIds.length === 0 || !db.payment?.findMany) return out;
  const payments: Array<{
    appointmentId: string | null;
    amount: number;
    status: string;
    refunds?: Array<{ amount: number }>;
  }> = await db.payment.findMany({
    where: {
      tenantId,
      appointmentId: { in: appointmentIds },
      status: { in: ["paid", "refunded"] },
      method: { not: "loyalty_points" },
    },
    select: {
      appointmentId: true,
      amount: true,
      status: true,
      refunds: { where: { status: "succeeded" }, select: { amount: true } },
    },
  });
  const totals = new Map<string, { charged: number; refunded: number }>();
  for (const p of payments ?? []) {
    if (!p.appointmentId) continue;
    const t = totals.get(p.appointmentId) ?? { charged: 0, refunded: 0 };
    const rows = p.refunds ?? [];
    // Refunded before refunds were recorded one by one: all of it.
    const refunded = rows.length > 0 ? rows.reduce((s, r) => s + r.amount, 0) : p.status === "refunded" ? p.amount : 0;
    t.charged += p.amount;
    t.refunded += refunded;
    totals.set(p.appointmentId, t);
  }
  for (const [id, t] of totals) {
    if (t.refunded > 0) out.set(id, keptShare(t.charged, t.refunded));
  }
  return out;
}
