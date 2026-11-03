import { AppointmentStatus, Prisma } from "@prisma/client";

/**
 * Which clients a professional (role staff) reaches: the ones with an
 * appointment with them that is not cancelled. Booking a client opens her
 * file to the professional (the booking is such an appointment); a
 * cancelled one no longer does. It used to count any appointment, so a
 * professional could book a client, cancel, and keep her whole file.
 *
 * One rule for every place that asks: the client list and file
 * (ClientsService.scopeWhere), consents, notices and rebooking
 * (ConsentService.assertClientInReach) and the till's search (which marks
 * the clients that are not theirs). `appointment` says whose appointments:
 * `{ professionalId }`, or `{ professional: { userId } }` from a token.
 */
export function clientReachWhere(appointment: Prisma.AppointmentWhereInput): Prisma.ClientWhereInput {
  return {
    appointments: { some: { ...appointment, status: { not: AppointmentStatus.cancelled } } },
  };
}

/**
 * A phone as the till shows it for a client who is not the professional's:
 * its last three digits ("···· 222"), enough to tell two namesakes apart.
 * Null with no phone.
 */
export function maskedPhone(phone: string | null | undefined): string | null {
  const digits = String(phone ?? "").replace(/\D/g, "");
  if (!digits) return null;
  return `···· ${digits.slice(-3)}`;
}

/** What a visit with another professional keeps in a client's file seen by staff: when, what and with whom. */
const OTHERS_VISIT_HIDDEN = ["price", "totalAmount", "amountPaid", "paymentStatus", "notes"] as const;

/**
 * A client as a professional (staff) sees her, in her list row or file:
 *
 * - Her visits with them stay complete. A visit with another professional
 *   shows the day, the time, the status, the services and who did them:
 *   no price, no payment and no notes (the colleague's notes and what the
 *   client paid them are not this professional's). Marked `restricted`.
 * - Her spend figures (`totalSpent`, `averageSpent`) are the salon's money
 *   from every visit and every purchase, so they are not shown to staff:
 *   null. Her visit count and first and last visit stay (not money).
 *
 * Owner and admin get the client as she is.
 */
export function clientAsStaffSees<T extends Record<string, any>>(client: T, professionalId: string): T {
  const out: Record<string, any> = { ...client, totalSpent: null, averageSpent: null };
  if (Array.isArray(client.appointments)) {
    out.appointments = client.appointments.map((visit: Record<string, any>) => {
      if (visit?.professional?.id === professionalId) return visit;
      const hidden: Record<string, any> = { ...visit, restricted: true };
      for (const key of OTHERS_VISIT_HIDDEN) if (key in hidden) hidden[key] = null;
      return hidden;
    });
  }
  return out as T;
}
