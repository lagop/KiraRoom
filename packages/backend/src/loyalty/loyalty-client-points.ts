import { expiryRuleText } from "./loyalty-expiry";

/**
 * What a client is told about their points (audit L3: they never were):
 * on the till's receipt and its email, and in the post-visit email. Plain
 * reads, so the receipt, the invoice email and the reviews can use them
 * without the loyalty module.
 */

/** Only what these reads use of Prisma. */
type Db = {
  loyaltyProgram: { findFirst: (args: any) => Promise<any> };
  loyaltyMember: { findUnique: (args: any) => Promise<any> };
  loyaltyTransaction: { findMany: (args: any) => Promise<Array<{ points: number }>> };
};

/** Whether the salon's plan includes loyalty (FeatureFlagService.isFeatureUnlocked). */
export type LoyaltyUnlocked = (tenantId: string) => Promise<boolean>;

export interface SaleLoyaltyBlock {
  /** Points this sale earned the client: its own lines and her visits on it. */
  pointsEarned: number;
  /** Her balance now (negative after a refund of points already spent). */
  balance: number;
  /** "Tus puntos caducan si pasan 12 meses sin visitas", or null. */
  expiryRule: string | null;
}

async function memberOf(db: Db, tenantId: string, clientId: string, unlocked?: LoyaltyUnlocked) {
  const program = await db.loyaltyProgram.findFirst({ where: { tenantId, isActive: true } });
  if (!program) return null;
  if (unlocked && !(await unlocked(tenantId).catch(() => false))) return null;
  const member = await db.loyaltyMember.findUnique({
    where: { clientId_programId: { clientId, programId: program.id } },
  });
  return member ? { program, member } : null;
}

/**
 * The receipt's loyalty block of a till sale, for the sale's client, or
 * null (no programme, no client, not a member). The points earned are read
 * from the ledger: the sale's own earn and her visits' earns.
 */
export async function saleLoyaltyBlock(
  db: Db,
  tenantId: string,
  sale: { saleId: string; clientId: string | null | undefined; appointmentIds: string[] },
  unlocked?: LoyaltyUnlocked,
): Promise<SaleLoyaltyBlock | null> {
  if (!sale.clientId) return null;
  const found = await memberOf(db, tenantId, sale.clientId, unlocked);
  if (!found) return null;
  const { program, member } = found;
  const earns = await db.loyaltyTransaction.findMany({
    where: {
      memberId: member.id,
      type: "earn",
      OR: [
        { source: "pos_sale", sourceId: sale.saleId },
        ...(sale.appointmentIds.length ? [{ source: "appointment", sourceId: { in: sale.appointmentIds } }] : []),
      ],
    },
    select: { points: true },
  });
  return {
    pointsEarned: earns.reduce((s, t) => s + t.points, 0),
    balance: member.currentPoints,
    expiryRule: expiryRuleText(program.pointsExpirationDays),
  };
}

/**
 * The line of the post-visit email ("Mostrar puntos en el email tras la
 * visita", on by default): the client's balance, when the salon's
 * programme is on, she is an active member and has points to tell. Null
 * otherwise (a zero or negative balance is not news to send her).
 */
export async function reviewEmailPoints(
  db: Db,
  tenantId: string,
  clientId: string | null | undefined,
  unlocked?: LoyaltyUnlocked,
): Promise<{ balance: number; expiryRule: string | null } | null> {
  if (!clientId) return null;
  const found = await memberOf(db, tenantId, clientId, unlocked);
  if (!found) return null;
  const { program, member } = found;
  if (program.showPointsInReviewEmail === false) return null;
  if (member.status && member.status !== "active") return null;
  if (!(member.currentPoints > 0)) return null;
  return { balance: member.currentPoints, expiryRule: expiryRuleText(program.pointsExpirationDays) };
}
