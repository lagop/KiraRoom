import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/** Anything that runs raw SQL: the Prisma client or a transaction. */
export interface RawQueryClient {
  $queryRaw<T = unknown>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]): Prisma.PrismaPromise<T>;
}

/**
 * The salon's open cash-drawer session, if any.
 *
 * Inside a transaction, `lock` holds the row until it commits:
 *
 * - `share` (a sale, a refund, a movement): the session cannot be closed
 *   while the money it records is being written. Several sales share it.
 * - `update` (closing it): waits for those to commit, then keeps any new
 *   one out until the close is committed. A sale that was waiting then sees
 *   the session closed (READ COMMITTED re-checks `status`) and finds none.
 *
 * Raw SQL bypasses the tenant layer, so it filters by tenant itself.
 */
export async function openCashSessionId(
  db: RawQueryClient,
  tenantId: string,
  lock: 'share' | 'update' | null = null,
): Promise<string | null> {
  const clause =
    lock === 'share' ? Prisma.sql`FOR SHARE` : lock === 'update' ? Prisma.sql`FOR UPDATE` : Prisma.empty;
  const rows = await db.$queryRaw<Array<{ id: string }>>(
    Prisma.sql`SELECT "id" FROM "cash_sessions" WHERE "tenantId" = ${tenantId} AND "status" = 'open' LIMIT 1 ${clause}`,
  );
  return rows?.[0]?.id ?? null;
}

/** 409 the till shows when cash is taken with the drawer closed. */
export function drawerClosed(): ConflictException {
  return new ConflictException({
    code: 'CASH_SESSION_CLOSED',
    message: 'La caja está cerrada: ábrela (Abrir caja) para cobrar en efectivo. Con tarjeta o Bizum puedes cobrar igualmente.',
  });
}

/** Whether what the client hands over includes cash (it goes into the drawer). */
export function takesCash(tenders: Array<{ method: string; amount: number }>): boolean {
  return tenders.some((t) => t.method === 'cash' && t.amount > 0);
}
