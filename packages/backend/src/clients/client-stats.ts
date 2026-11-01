import { Logger } from "@nestjs/common";
import { AppointmentStatus, PaymentMethod, PaymentStatus, Prisma } from "@prisma/client";

/**
 * A client's visit and spend figures (`clients.visitCount`, `firstVisit`,
 * `lastVisit`, `totalSpent`, `averageSpent`), computed from what happened.
 *
 * Nothing used to write them: every client had 0 visits, no last visit and
 * 0 € spent, so the re-engagement campaigns took every client for an
 * inactive one, the briefing's "clientas en riesgo" listed whoever was
 * created first, and the copilot's rankings were in creation order.
 *
 * - A visit is an appointment of hers that is **completed**. Its day is the
 *   appointment's `scheduledDate` (the salon's calendar day).
 * - `firstVisit` is her first completed visit; with none yet, the day she
 *   was created (the column cannot be empty).
 * - `lastVisit` is her latest completed visit; null with none.
 * - `totalSpent` is the money the salon has recorded from her: her payments
 *   marked paid (a refunded payment is `refunded`, so it drops out) less what
 *   was given back of them by partial refunds (the payment stays paid), except
 *   the part paid with loyalty points, which is not money. Payments are in
 *   **cents** (`payments.amount`); the column is in **euros**, as the seed
 *   and the loyalty member's `totalSpent` are, hence / 100.
 * - `averageSpent` is `totalSpent / visitCount`, in euros, 2 decimals; 0
 *   with no visit.
 *
 * Recomputed from scratch each time (so calling it twice changes nothing)
 * after anything that can change them: an appointment's status change, and
 * a payment recorded, confirmed or refunded. Existing clients were filled
 * by the migration 20261101100000_client_stats_backfill, with the same rules
 * in SQL.
 *
 * `loyaltyTier` is not one of them: no rule ever defined it (the loyalty
 * programme's levels live on the loyalty member), so it is left as it is.
 */
export interface ClientStats {
  visitCount: number;
  firstVisit: Date;
  lastVisit: Date | null;
  totalSpent: Prisma.Decimal;
  averageSpent: Prisma.Decimal;
}

/** The arithmetic, kept free of the database. */
export function clientStatsFrom(input: {
  visitCount: number;
  firstVisit: Date | null;
  lastVisit: Date | null;
  paidCents: number;
  createdAt: Date;
}): ClientStats {
  const visitCount = Math.max(0, input.visitCount);
  const cents = Math.max(0, Math.round(input.paidCents));
  const totalSpent = new Prisma.Decimal(cents).div(100);
  const averageSpent =
    visitCount > 0
      ? totalSpent.div(visitCount).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
      : new Prisma.Decimal(0);
  return {
    visitCount,
    firstVisit: visitCount > 0 && input.firstVisit ? input.firstVisit : input.createdAt,
    lastVisit: visitCount > 0 ? input.lastVisit : null,
    totalSpent,
    averageSpent,
  };
}

/** The part of Prisma this needs (the service, or a transaction). */
export interface ClientStatsDb {
  client: {
    findFirst: (args: any) => Promise<{ createdAt: Date } | null>;
    updateMany: (args: any) => Promise<{ count: number }>;
  };
  appointment: { aggregate: (args: any) => Promise<any> };
  payment: { aggregate: (args: any) => Promise<any> };
  /** Partial refunds of her paid payments. Optional: without it they are not taken off. */
  refund?: { aggregate: (args: any) => Promise<any> };
}

/** Recomputes one client's figures and writes them. Null if she is not this salon's. */
export async function recomputeClientStats(
  db: ClientStatsDb,
  tenantId: string,
  clientId: string,
): Promise<ClientStats | null> {
  const paidWhere = {
    tenantId,
    clientId,
    status: PaymentStatus.paid,
    method: { not: PaymentMethod.loyalty_points },
  };
  const [client, visits, paid, refunded] = await Promise.all([
    db.client.findFirst({ where: { id: clientId, tenantId }, select: { createdAt: true } }),
    db.appointment.aggregate({
      where: { tenantId, clientId, status: AppointmentStatus.completed },
      _count: { _all: true },
      _min: { scheduledDate: true },
      _max: { scheduledDate: true },
    }),
    db.payment.aggregate({ where: paidWhere, _sum: { amount: true } }),
    // Given back of payments still paid: partial refunds.
    db.refund?.aggregate
      ? db.refund.aggregate({ where: { status: "succeeded", payment: paidWhere }, _sum: { amount: true } })
      : Promise.resolve(null),
  ]);
  if (!client) return null;
  const stats = clientStatsFrom({
    visitCount: Number(visits?._count?._all ?? 0),
    firstVisit: visits?._min?.scheduledDate ?? null,
    lastVisit: visits?._max?.scheduledDate ?? null,
    paidCents: Number(paid?._sum?.amount ?? 0) - Number(refunded?._sum?.amount ?? 0),
    createdAt: client.createdAt,
  });
  await db.client.updateMany({ where: { id: clientId, tenantId }, data: stats });
  return stats;
}

const logger = new Logger("ClientStats");

/**
 * The same, for code that does it on the side (a status change, a
 * payment): never fails its caller, only logs. Each client once.
 */
export async function refreshClientStats(
  db: ClientStatsDb,
  tenantId: string,
  clientIds: Iterable<string | null | undefined>,
): Promise<void> {
  for (const clientId of new Set([...clientIds].filter((id): id is string => !!id))) {
    try {
      await recomputeClientStats(db, tenantId, clientId);
    } catch (err) {
      logger.warn(`client stats for ${clientId} not recomputed: ${(err as Error).message}`);
    }
  }
}
