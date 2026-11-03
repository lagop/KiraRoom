/**
 * Who on the salon's team gets the bell notice for an appointment event
 * (created, confirmed, completed, cancelled, rescheduled, no-show).
 *
 * It used to be the users with role "admin" only, so an owner without a
 * manager never saw a booking or a cancellation in the panel. Now it is the
 * owner and the admins (active accounts), minus the professional's own
 * user, who already gets their own notice, and minus anyone who turned the
 * in-app channel off for that kind of notice in their preferences.
 */
export const SALON_TEAM_NOTICE_ROLES = ["owner", "admin"] as const;

interface UserFinder {
  user: {
    findMany(args: {
      where: { tenantId: string; role: { in: string[] }; isActive: boolean };
      select: { id: true };
    }): Promise<Array<{ id: string }>>;
  };
}

interface PreferenceChecker {
  shouldSendNotificationForUser(
    userId: string,
    notificationType: string,
    channel: "inApp",
  ): Promise<boolean>;
}

export async function salonTeamRecipients(
  prisma: UserFinder,
  preferences: PreferenceChecker,
  tenantId: string,
  notificationType: string,
  professionalUserId?: string | null,
): Promise<Array<{ id: string }>> {
  const users = await prisma.user.findMany({
    where: {
      tenantId,
      role: { in: [...SALON_TEAM_NOTICE_ROLES] },
      isActive: true,
    },
    select: { id: true },
  });
  const seen = new Set<string>();
  const out: Array<{ id: string }> = [];
  for (const u of users) {
    if (seen.has(u.id)) continue;
    seen.add(u.id);
    if (professionalUserId && u.id === professionalUserId) continue;
    let wanted = true;
    try {
      wanted = await preferences.shouldSendNotificationForUser(
        u.id,
        notificationType,
        "inApp",
      );
    } catch {
      // A failed preference lookup never hides a booking from the salon.
      wanted = true;
    }
    if (wanted) out.push({ id: u.id });
  }
  return out;
}
