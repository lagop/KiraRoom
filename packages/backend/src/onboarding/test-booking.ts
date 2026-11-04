/**
 * The onboarding's test booking (D27) and its test client are for the
 * owner to see how the agenda works. Nothing about them goes to anyone: no
 * confirmation, reminder, review request, wait-list offer, rebooking
 * reminder or campaign (O5). The client-facing senders filter on these.
 */
export function isTestBooking(
  appointment: { isTest?: boolean | null; client?: { isTest?: boolean | null } | null } | null | undefined,
): boolean {
  return !!appointment && (appointment.isTest === true || appointment.client?.isTest === true);
}

/** Prisma filter: an appointment that is neither a test booking nor a test client's. */
export const NOT_TEST_APPOINTMENT = { isTest: false, client: { isTest: false } } as const;
