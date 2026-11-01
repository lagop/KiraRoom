import { Prisma } from "@prisma/client";
import { numberOrNull } from "./commission-rate";
import { keptShare, roundCommission } from "./commission-refunds";

/**
 * Commission clawback: a refund given after the commission was paid.
 *
 * How commissions are paid (commissions.service.ts): nothing is stored per
 * period; each visit and each walk-in service line carries `commissionPaid`
 * and `commissionDate`, set by POST /commissions/pay, which pays what the
 * item earns after the refunds made so far (commission-refunds.ts). A refund
 * made BEFORE that payout lowers what is paid. A refund made AFTER it used to
 * only lower the figures on the fly, rewriting the paid period and taking
 * nothing back from the professional.
 *
 * Now, when a refund hits a visit or a line whose commission was already
 * paid, the refund records a negative CommissionAdjustment for its
 * professional ("Ajuste por devolución"), linked to the refund:
 *
 *   - its amount is what the refund takes off the item's commission:
 *     commission x (kept share before the refund - kept share after it),
 *     the same proportions as commission-refunds.ts, so the adjustments of
 *     an item never add up to more than was paid for it;
 *   - it shows in the summary as pending until the next payout settles it
 *     (it is netted into that payout), and in the payroll report of the
 *     period it was recorded in;
 *   - the payroll report of the paid item's own period adds it back, so that
 *     period keeps the figure that was paid (it is not rewritten);
 *   - one per refund and item (unique refundId + sourceKey): recording the
 *     same refund again changes nothing.
 *
 * The commission read is the one the payout and the payroll report use:
 * the stored commissionAmount (0 when none).
 */

export const REFUND_ADJUSTMENT_LABEL = "Ajuste por devolución";

export const appointmentSourceKey = (id: string) => `appointment:${id}`;
export const saleLineSourceKey = (id: string) => `sale_line:${id}`;

/**
 * What a refund takes off a commission: negative, two decimals; 0 when it
 * takes nothing (nothing charged, nothing left to give back).
 */
export function clawbackAmount(
  commission: number,
  chargedCents: number,
  refundedBeforeCents: number,
  refundedAfterCents: number,
): number {
  if (!(commission > 0) || !(chargedCents > 0)) return 0;
  const taken = commission * (keptShare(chargedCents, refundedBeforeCents) - keptShare(chargedCents, refundedAfterCents));
  const rounded = roundCommission(taken);
  return rounded > 0 ? -rounded : 0;
}

type Db = Prisma.TransactionClient | any;

export interface RefundForClawback {
  tenantId: string;
  refundId: string;
  /** Money cents of this refund. */
  amount: number;
  /** The refunded payment's visit, if it paid one. */
  appointmentId?: string | null;
  /** The refunded payment's method: points are not money and earn no clawback. */
  method?: string | null;
  /** The till sale lines this refund gave back (Refund.saleLines). */
  lines?: Array<{ lineId: string; cents: number }>;
}

/**
 * Records the clawbacks of a refund, inside the refund's transaction (after
 * the refund row, the lines' refundedCents and the payment are written).
 * Returns how many adjustments were recorded now.
 */
export async function recordRefundClawbacks(db: Db, refund: RefundForClawback): Promise<number> {
  if (!db.commissionAdjustment?.createMany) return 0;
  const rows: Prisma.CommissionAdjustmentCreateManyInput[] = [];

  // A visit: its commission scaled by the share of its money payments kept.
  if (refund.appointmentId && refund.method !== "loyalty_points") {
    const apt = await db.appointment.findFirst({
      where: { id: refund.appointmentId, tenantId: refund.tenantId },
      select: { id: true, professionalId: true, commissionPaid: true, commissionAmount: true },
    });
    if (apt?.commissionPaid && apt.professionalId) {
      const { charged, refunded } = await appointmentMoney(db, refund.tenantId, apt.id);
      const amount = clawbackAmount(
        numberOrNull(apt.commissionAmount) ?? 0,
        charged,
        Math.max(0, refunded - refund.amount),
        refunded,
      );
      if (amount < 0) {
        rows.push({
          tenantId: refund.tenantId,
          professionalId: apt.professionalId,
          refundId: refund.refundId,
          appointmentId: apt.id,
          sourceKey: appointmentSourceKey(apt.id),
          amount,
        });
      }
    }
  }

  // Walk-in service lines of a till sale: each scaled by what is left of it.
  const given = (refund.lines ?? []).filter((l) => l.cents > 0);
  if (given.length > 0) {
    const lines: Array<{
      id: string;
      professionalId: string | null;
      commissionPaid: boolean;
      commissionAmount: unknown;
      totalCents: number;
      refundedCents: number | null;
    }> = await db.posSaleLine.findMany({
      where: {
        tenantId: refund.tenantId,
        id: { in: given.map((l) => l.lineId) },
        kind: "service",
        commissionPaid: true,
        professionalId: { not: null },
      },
      select: {
        id: true,
        professionalId: true,
        commissionPaid: true,
        commissionAmount: true,
        totalCents: true,
        refundedCents: true,
      },
    });
    const centsOf = new Map(given.map((l) => [l.lineId, l.cents]));
    for (const line of lines) {
      const after = line.refundedCents ?? 0;
      const amount = clawbackAmount(
        numberOrNull(line.commissionAmount) ?? 0,
        line.totalCents,
        Math.max(0, after - (centsOf.get(line.id) ?? 0)),
        after,
      );
      if (amount < 0 && line.professionalId) {
        rows.push({
          tenantId: refund.tenantId,
          professionalId: line.professionalId,
          refundId: refund.refundId,
          posSaleLineId: line.id,
          sourceKey: saleLineSourceKey(line.id),
          amount,
        });
      }
    }
  }

  if (rows.length === 0) return 0;
  const created = await db.commissionAdjustment.createMany({ data: rows, skipDuplicates: true });
  return created?.count ?? 0;
}

/** What was charged in money for a visit and what was given back of it (as appointmentKeptShares reads it). */
async function appointmentMoney(db: Db, tenantId: string, appointmentId: string) {
  const payments: Array<{ amount: number; status: string; refunds?: Array<{ amount: number }> }> =
    await db.payment.findMany({
      where: {
        tenantId,
        appointmentId,
        status: { in: ["paid", "refunded"] },
        method: { not: "loyalty_points" },
      },
      select: { amount: true, status: true, refunds: { where: { status: "succeeded" }, select: { amount: true } } },
    });
  let charged = 0;
  let refunded = 0;
  for (const p of payments ?? []) {
    const rows = p.refunds ?? [];
    charged += p.amount;
    refunded += rows.length > 0 ? rows.reduce((s, r) => s + r.amount, 0) : p.status === "refunded" ? p.amount : 0;
  }
  return { charged, refunded };
}

/**
 * Per item (sourceKey), what its clawbacks took back, as a positive number:
 * the payroll report adds it back to the item's own period, which keeps the
 * figure that was paid (the clawback counts in its own period instead).
 */
export async function clawedBackBySource(
  db: Db,
  tenantId: string,
  items: { appointmentIds?: string[]; lineIds?: string[] },
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  const keys = [
    ...(items.appointmentIds ?? []).map(appointmentSourceKey),
    ...(items.lineIds ?? []).map(saleLineSourceKey),
  ];
  if (keys.length === 0 || !db.commissionAdjustment?.findMany) return out;
  const rows: Array<{ sourceKey: string; amount: unknown }> = await db.commissionAdjustment.findMany({
    where: { tenantId, sourceKey: { in: keys } },
    select: { sourceKey: true, amount: true },
  });
  for (const r of rows) {
    out.set(r.sourceKey, roundCommission((out.get(r.sourceKey) ?? 0) - (numberOrNull(r.amount) ?? 0)));
  }
  return out;
}
