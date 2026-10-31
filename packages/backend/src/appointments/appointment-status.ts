import { ConflictException } from "@nestjs/common";
import { AppointmentStatus } from "@prisma/client";

/**
 * Which status an appointment may move to from each status. The one table
 * every status change is checked against: the panel's PATCH, the cancel /
 * complete / no-show endpoints, the client cancelling from the salon site,
 * the copilot's no-show tool, a multi-service visit whose services are all
 * done, and a payment that marks its appointment completed or cancelled.
 *
 * There were no rules before: a cancelled appointment could be completed,
 * and completing twice issued two invoices.
 *
 * Completed and cancelled are final. A completed visit has its invoice
 * (VERI*FACTU records cannot be withdrawn) and its points; a cancelled slot
 * may already be someone else's, so it is booked again, not revived.
 *
 * No-show has one way back, on purpose: to confirmed, for a client who
 * turns up late after being marked, or a no-show marked by mistake. From
 * there the visit is started or completed as usual.
 */
export const APPOINTMENT_STATUS_TRANSITIONS: Readonly<
  Record<AppointmentStatus, readonly AppointmentStatus[]>
> = {
  [AppointmentStatus.pending]: [
    AppointmentStatus.confirmed,
    AppointmentStatus.in_progress,
    AppointmentStatus.completed,
    AppointmentStatus.cancelled,
    AppointmentStatus.no_show,
  ],
  [AppointmentStatus.confirmed]: [
    AppointmentStatus.in_progress,
    AppointmentStatus.completed,
    AppointmentStatus.cancelled,
    AppointmentStatus.no_show,
  ],
  // Back to confirmed undoes a "start" pressed too early. A client who is
  // already in the chair is not a no-show.
  [AppointmentStatus.in_progress]: [
    AppointmentStatus.confirmed,
    AppointmentStatus.completed,
    AppointmentStatus.cancelled,
  ],
  [AppointmentStatus.completed]: [],
  [AppointmentStatus.cancelled]: [],
  [AppointmentStatus.no_show]: [AppointmentStatus.confirmed],
};

/** How a status reads in a sentence ("una cita completada"). */
const STATUS_WORD: Record<AppointmentStatus, string> = {
  [AppointmentStatus.pending]: "pendiente",
  [AppointmentStatus.confirmed]: "confirmada",
  [AppointmentStatus.in_progress]: "en curso",
  [AppointmentStatus.completed]: "completada",
  [AppointmentStatus.cancelled]: "cancelada",
  [AppointmentStatus.no_show]: "marcada como no presentada",
};

export function canTransition(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return (APPOINTMENT_STATUS_TRANSITIONS[from] ?? []).includes(to);
}

/** Why a change is refused, in the panel's language. */
export function transitionRefusal(from: AppointmentStatus, to: AppointmentStatus): string {
  if (from === to) return `La cita ya está ${STATUS_WORD[to]}.`;
  return `Una cita ${STATUS_WORD[from]} no puede pasar a ${STATUS_WORD[to]}.`;
}

/** 409 with the reason, unless the table allows the change. */
export function assertTransition(from: AppointmentStatus, to: AppointmentStatus): void {
  if (canTransition(from, to)) return;
  throw new ConflictException({
    code: "INVALID_STATUS_TRANSITION",
    message: transitionRefusal(from, to),
    from,
    to,
  });
}

/** The 409 for a status that changed between our read and our write. */
export function concurrentChange(): ConflictException {
  return new ConflictException({
    code: "STATUS_CHANGED",
    message: "La cita acaba de cambiar de estado. Recarga y vuelve a intentarlo.",
  });
}

/**
 * Statuses that need the service's consent forms signed. Checked on the way
 * in, so a visit that skips "confirmed" (pending straight to completed)
 * cannot skip the consent either; a confirmed one was checked already.
 */
const CONSENT_GATED: ReadonlySet<AppointmentStatus> = new Set([
  AppointmentStatus.confirmed,
  AppointmentStatus.in_progress,
  AppointmentStatus.completed,
]);

export function needsConsent(from: AppointmentStatus, to: AppointmentStatus): boolean {
  return CONSENT_GATED.has(to) && !CONSENT_GATED.has(from);
}

/** Prisma's "no row matched" on an update whose where included the status. */
export function isStaleWrite(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "P2025";
}

/**
 * For code that changes the status as a by-product, not on request: a
 * payment marks its appointment completed, a refund cancelled. The change
 * is applied only when the table allows it, and only if nobody changed the
 * status in between; otherwise the appointment is left as it is and the
 * caller carries on (a payment is never refused for it). Returns whether
 * the status changed.
 */
export async function applyStatusIfAllowed(
  prisma: {
    appointment: {
      findUnique: (args: any) => Promise<{ status: AppointmentStatus } | null>;
      updateMany: (args: any) => Promise<{ count: number }>;
    };
  },
  appointmentId: string,
  to: AppointmentStatus,
): Promise<boolean> {
  const current = await prisma.appointment.findUnique({
    where: { id: appointmentId },
    select: { status: true },
  });
  if (!current || !canTransition(current.status, to)) return false;
  const { count } = await prisma.appointment.updateMany({
    where: { id: appointmentId, status: current.status },
    data: { status: to },
  });
  return count === 1;
}
