import { salonInstant } from "./salon-time";

/**
 * A client can only fail to turn up once her appointment has begun. Marking
 * a no-show earlier (from the panel or the copilot) closed an appointment
 * two days ahead, and its reminder never went out.
 */
export const NO_SHOW_BEFORE_START_MESSAGE =
  "La cita todavía no ha empezado: solo se puede marcar como no presentada a partir de su hora.";

/** Whether the appointment's start, on the salon's clock, is still ahead. */
export function startsLater(
  apt: { scheduledDate: Date | string; scheduledTime: string },
  timeZone: string,
  now: Date = new Date(),
): boolean {
  if (!apt.scheduledDate || !apt.scheduledTime) return false;
  return salonInstant(apt.scheduledDate, apt.scheduledTime, timeZone).getTime() > now.getTime();
}
