/**
 * One lock per salon and professional for what decides a commission payout:
 * "Pagar" (commissions.service.ts payCommission) and a refund's clawback
 * (commission-clawback.ts). Both run inside a transaction and take it first,
 * so:
 *   - two "Pagar" at once for the same professional run one after the
 *     other: the second finds nothing pending and gets a 409 instead of a
 *     second success;
 *   - a refund either lands before the payout (it lowers what is paid) or
 *     after it (it sees the item paid and records its adjustment), never in
 *     between.
 * A transaction-level advisory lock: released on commit or rollback.
 * Several professionals are locked in a fixed order, so two transactions
 * never wait on each other.
 */

type Tx = { $executeRaw: (query: TemplateStringsArray, ...values: unknown[]) => Promise<unknown> };

export function commissionLockKey(tenantId: string, professionalId: string): string {
  return `commission:${tenantId}:${professionalId}`;
}

export async function lockProfessionalCommissions(
  tx: Tx,
  tenantId: string,
  professionalIds: Array<string | null | undefined>,
): Promise<void> {
  if (typeof tx.$executeRaw !== "function") return;
  const ids = [...new Set(professionalIds.filter((id): id is string => !!id))].sort();
  for (const id of ids) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${commissionLockKey(tenantId, id)}))`;
  }
}
