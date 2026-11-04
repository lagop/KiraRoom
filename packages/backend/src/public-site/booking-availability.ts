import { isReadOnlyStatus } from "../common/guards/read-only-tenant.guard";

/**
 * Why the salon's page and widget take no online booking right now, or null
 * when they do:
 * - "read_only": trial ended, cancelled or suspended; the booking would be
 *   refused at the end (appointments.service).
 * - "no_professional": nobody active to book with (a new salon between its
 *   first service and its first professional, or a team all switched off);
 *   getAvailableSlots offers nothing then (audit 7 N11).
 */
export type BookingUnavailableReason = "read_only" | "no_professional";

export function bookingUnavailableReason(
  subscriptionStatus: string | null | undefined,
  activeProfessionals: number,
): BookingUnavailableReason | null {
  if (isReadOnlyStatus(subscriptionStatus)) return "read_only";
  if (activeProfessionals <= 0) return "no_professional";
  return null;
}
