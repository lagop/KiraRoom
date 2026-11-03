import { AppointmentStatus, PaymentStatus } from "@prisma/client";
import { effectiveCommissionRate, numberOrNull } from "./commission-rate";

/**
 * An appointment's commission: a snapshot taken when the visit is completed
 * AND paid.
 *
 * Every appointment used to be created with `commissionAmount = 0` (the
 * column's default) and no panel flow ever wrote it again, while the
 * summary, "Pagar", the payroll report and the refund clawback read the
 * stored 0 before the rate: appointments earned 0 EUR of commission.
 *
 * Now:
 *   - `commissionAmount` is null until the commission is worked out (a real
 *     0 % rate stores 0, which is a commission of 0, not "not computed");
 *   - when the visit is completed and paid (status change, payment, till
 *     checkout, the manual payment correction), snapshotAppointmentCommission
 *     stores the rate that applies (the appointment's own, else the
 *     professional's, else the default: effectiveCommissionRate) and the
 *     amount, round(totalAmount x rate / 100) in whole cents. The rate is
 *     then fixed: changing the professional's rate later does not rewrite
 *     visits already done, the same as a till sale line keeps the rate it
 *     was sold with;
 *   - while the commission is not paid out (`commissionPaid = false`), the
 *     amount follows the visit's total and the appointment's rate: it is
 *     recomputed when either changes (and read as rate x total, so a stored
 *     amount that is stale or 0 is never trusted);
 *   - once paid, the stored amount is what was paid ("Pagar" writes it in
 *     the same transaction) and is never rewritten: the payroll report and
 *     the refund clawback read it.
 *
 * Amounts are cents of the catalogue figure, as `totalAmount`
 * (payments/appointment-charge.ts).
 */

/** A commission in whole cents: base x rate / 100, rounded once, at the source. */
export function commissionCents(baseCents: number, rate: number): number {
  const base = Number(baseCents);
  if (!Number.isFinite(base) || !Number.isFinite(rate)) return 0;
  return Math.round((base * rate) / 100);
}

export interface AppointmentCommissionFields {
  totalAmount: unknown;
  commissionRate: unknown;
  commissionAmount: unknown;
  commissionPaid?: boolean | null;
}

/**
 * The rate and the full commission (before refunds, whole cents) of a visit,
 * as the summary, "Pagar", the payroll report and the clawback read it.
 */
export function appointmentCommission(
  apt: AppointmentCommissionFields,
  professionalRate: unknown,
): { rate: number; amount: number } {
  const rate = effectiveCommissionRate(apt.commissionRate, professionalRate);
  const computed = commissionCents(Number(apt.totalAmount ?? 0), rate);
  if (apt.commissionPaid) {
    // Paid out: what was paid. Only a row never worked out (null) is computed.
    const stored = numberOrNull(apt.commissionAmount);
    return { rate, amount: stored ?? computed };
  }
  return { rate, amount: computed };
}

/** What the snapshot reads of an appointment. */
export const COMMISSION_SNAPSHOT_SELECT = {
  id: true,
  status: true,
  paymentStatus: true,
  commissionPaid: true,
  totalAmount: true,
  commissionRate: true,
  commissionAmount: true,
  professional: { select: { commissionRate: true } },
} as const;

type Db = { appointment: { findFirst: (args: any) => Promise<any>; updateMany: (args: any) => Promise<{ count: number }> } };

/**
 * Stores the commission snapshot of a visit that is completed and paid and
 * whose commission is not paid out yet; recomputes it when its total or its
 * rate changed. Does nothing otherwise. Returns whether it wrote.
 */
export async function snapshotAppointmentCommission(db: Db, tenantId: string, appointmentId: string): Promise<boolean> {
  const apt = await db.appointment.findFirst({
    where: { id: appointmentId, tenantId },
    select: COMMISSION_SNAPSHOT_SELECT,
  });
  if (!apt || apt.commissionPaid) return false;
  if (apt.status !== AppointmentStatus.completed || apt.paymentStatus !== PaymentStatus.paid) return false;
  const { rate, amount } = appointmentCommission(apt, apt.professional?.commissionRate);
  if (numberOrNull(apt.commissionRate) === rate && numberOrNull(apt.commissionAmount) === amount) return false;
  const { count } = await db.appointment.updateMany({
    where: { id: appointmentId, tenantId, commissionPaid: false },
    data: { commissionRate: rate, commissionAmount: amount },
  });
  return count > 0;
}

/**
 * The same for side effects (a status change, a payment, a till sale):
 * never fails the caller, logs instead. Reads already compute the figure,
 * and "Pagar" writes it, so a snapshot missed here is not lost.
 */
export async function snapshotAppointmentCommissions(
  db: Db,
  tenantId: string,
  appointmentIds: Array<string | null | undefined>,
  logger?: { warn: (message: string) => void },
): Promise<void> {
  for (const id of new Set(appointmentIds.filter((x): x is string => !!x))) {
    try {
      await snapshotAppointmentCommission(db, tenantId, id);
    } catch (err) {
      logger?.warn(`commission snapshot for appointment ${id} failed: ${(err as Error).message}`);
    }
  }
}
