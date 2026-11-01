import { UserRole } from "@prisma/client";
import type { Prisma } from "@prisma/client";

type UserWriter = Pick<Prisma.TransactionClient, "user">;

/**
 * Ends a professional's own login to the panel: the account is deactivated
 * and every token it holds stops working (tokenVersion). The same as
 * "Quitar acceso" on the team screen.
 *
 * Deactivating or deleting a professional used to leave it on, so someone
 * who had left the salon could still sign in and see the agenda and their
 * clients. Only a staff account is touched: the owner's own professional
 * record is linked to the salon's main account, which never goes this way.
 *
 * Reactivating the professional does not give it back: the owner does that
 * on purpose, with a new password, from the team screen.
 *
 * Returns whether a login was turned off.
 */
export async function revokePanelLogin(
  db: UserWriter,
  tenantId: string,
  userId: string | null | undefined,
): Promise<boolean> {
  if (!userId) return false;
  const { count } = await db.user.updateMany({
    where: { id: userId, tenantId, role: UserRole.staff, isActive: true },
    data: { isActive: false, tokenVersion: { increment: 1 } },
  });
  return count > 0;
}
