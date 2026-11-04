import type { Prisma } from "@prisma/client";

/**
 * What a salon may still send to its clients (audit 8 D5, owner's decision
 * 2026-11-04):
 *
 * - read-only (trial ended, cancelled, suspended, or deleted from the
 *   console): the reminders of appointments already booked still go out (the
 *   clients are coming); marketing campaigns, re-engagement, rebooking
 *   reminders and review requests stop;
 * - blocked from the console (abuse): nothing at all.
 *
 * Every scheduled sender filters its query with one of these, so a new sender
 * picks the rule up by using them (send-policy.spec.ts lists them all).
 */

const READ_ONLY_STATUSES = ["cancelled", "suspended"] as const;

/** Appointment reminders: any salon not blocked and not deleted. */
export const REMINDER_SENDS_TENANT_WHERE: Prisma.TenantWhereInput = {
  deletedAt: null,
  blockedAt: null,
};

/** Campaigns, re-engagement, rebooking reminders, review requests: salons with an active plan only. */
export const MARKETING_SENDS_TENANT_WHERE: Prisma.TenantWhereInput = {
  deletedAt: null,
  blockedAt: null,
  subscriptionStatus: { notIn: [...READ_ONLY_STATUSES] },
};

export interface SendPolicyTenant {
  subscriptionStatus?: string | null;
  deletedAt?: Date | string | null;
  blockedAt?: Date | string | null;
}

export function canSendReminders(t: SendPolicyTenant | null | undefined): boolean {
  return !!t && !t.deletedAt && !t.blockedAt;
}

export function canSendMarketing(t: SendPolicyTenant | null | undefined): boolean {
  return canSendReminders(t) && !(READ_ONLY_STATUSES as readonly string[]).includes(t!.subscriptionStatus ?? "");
}
