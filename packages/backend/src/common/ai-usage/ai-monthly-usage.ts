import { Prisma } from '@prisma/client';

/**
 * The month's AI message count on the tenant row.
 *
 * `Tenant.aiConversationsUsed` counts the messages of the month in
 * `Tenant.aiConversationsPeriod` (YYYY-MM, UTC). A count from another month
 * reads as 0, and the first message of a new month restarts it at 1, so a
 * missed monthly reset can never carry usage over (before this, the reset
 * job was never registered and the count ran from signup).
 */

/** This month as YYYY-MM in UTC. */
export function aiUsagePeriod(now: Date = new Date()): string {
  return now.toISOString().slice(0, 7);
}

/** When the next month's count starts: the 1st, 00:00 UTC. */
export function nextAiUsagePeriodStart(now: Date = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
}

export interface AiUsageColumns {
  aiConversationsUsed?: number | null;
  aiConversationsPeriod?: string | null;
}

/** The count, if it belongs to this month; 0 otherwise. */
export function aiUsageThisMonth(row: AiUsageColumns | null | undefined, now: Date = new Date()): number {
  if (!row || row.aiConversationsPeriod !== aiUsagePeriod(now)) return 0;
  return row.aiConversationsUsed ?? 0;
}

/** Select these with aiUsageThisMonth(). */
export const AI_USAGE_SELECT = { aiConversationsUsed: true, aiConversationsPeriod: true } as const;

type RawClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

/**
 * Adds `by` to this month's count in one statement (correct under
 * concurrent calls), restarting from 0 when the stored month is another.
 * Returns the new count, or 0 for an unknown tenant.
 */
export async function incrementAiUsage(
  prisma: RawClient,
  tenantId: string,
  by = 1,
  now: Date = new Date(),
): Promise<number> {
  const period = aiUsagePeriod(now);
  const rows = await prisma.$queryRaw<{ used: number }[]>`
    UPDATE "tenants"
    SET "aiConversationsUsed" = CASE WHEN "aiConversationsPeriod" = ${period}
                                     THEN "aiConversationsUsed" + ${by}::int ELSE ${by}::int END,
        "aiConversationsPeriod" = ${period}
    WHERE "id" = ${tenantId}
    RETURNING "aiConversationsUsed" AS used`;
  return Number(rows[0]?.used ?? 0);
}
