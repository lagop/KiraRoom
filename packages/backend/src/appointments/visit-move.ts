/**
 * Moving one service of a multi-service appointment (a client's visit with
 * several services, possibly with several professionals). Pure: the service
 * that applies it is AppointmentsService.moveVisitService; this file decides
 * where every service ends up and whether the result makes sense for the
 * client. Tested in visit-move.spec.ts.
 *
 * Moving only the dragged service used to be the only behaviour: moved
 * earlier it left the client waiting between services, moved later it could
 * put her in two chairs at once, and the appointment's own time (list,
 * reminders, what she was told) stayed the old one.
 *
 * - scope "visit" (the default): every service shifts by the same amount,
 *   keeping their order and the time between them.
 * - scope "service" (owners and managers only, for a wait agreed with the
 *   client): only the dragged service moves; it may not overlap another of
 *   her services, since she cannot be in two places.
 */

export type MoveScope = "visit" | "service";

export interface VisitService {
  id: string;
  professionalId: string;
  start: Date;
  end: Date;
  isParallel: boolean;
}

/**
 * Where each service of a visit is now, the way the calendar draws it: its
 * stored start and end when it has them; otherwise parallel services start
 * with the appointment and serial ones follow each other from it.
 */
export function currentVisitSchedule(input: {
  appointmentStart: Date;
  appointmentProfessionalId: string;
  services: Array<{
    id: string;
    professionalId: string | null;
    scheduledStart: Date | null;
    scheduledEnd: Date | null;
    isParallel: boolean;
    durationMinutes: number;
  }>;
}): VisitService[] {
  let cursor = input.appointmentStart.getTime();
  return input.services.map((s) => {
    let start: Date;
    let end: Date;
    if (s.scheduledStart && s.scheduledEnd) {
      start = new Date(s.scheduledStart);
      end = new Date(s.scheduledEnd);
    } else if (s.isParallel) {
      start = new Date(input.appointmentStart);
      end = new Date(start.getTime() + s.durationMinutes * 60_000);
    } else {
      start = new Date(cursor);
      end = new Date(cursor + s.durationMinutes * 60_000);
    }
    if (!s.isParallel) cursor = end.getTime();
    return { id: s.id, professionalId: s.professionalId ?? input.appointmentProfessionalId, start, end, isParallel: s.isParallel };
  });
}

/** The visit after dropping `draggedId` at `newStart` (and maybe on another professional). */
export function planVisitMove(
  services: VisitService[],
  draggedId: string,
  newStart: Date,
  scope: MoveScope,
  newProfessionalId?: string,
): VisitService[] {
  const dragged = services.find((s) => s.id === draggedId);
  if (!dragged) throw new Error("Service not in this visit");
  const delta = newStart.getTime() - dragged.start.getTime();
  return services.map((s) => {
    const shifts = scope === "visit" || s.id === draggedId;
    const professionalId = s.id === draggedId && newProfessionalId ? newProfessionalId : s.professionalId;
    return shifts
      ? { ...s, professionalId, start: new Date(s.start.getTime() + delta), end: new Date(s.end.getTime() + delta) }
      : { ...s, professionalId };
  });
}

/**
 * The timing editor in the appointment card: one service gets a new start
 * and end, and the serial services after it follow on (as before).
 */
export function planRetime(services: VisitService[], id: string, start: Date, end: Date): VisitService[] {
  const index = services.findIndex((s) => s.id === id);
  if (index === -1) throw new Error("Service not in this visit");
  let cursor = end.getTime();
  return services.map((s, i) => {
    if (i < index) return s;
    if (i === index) return { ...s, start, end };
    if (s.isParallel) return s;
    const length = s.end.getTime() - s.start.getTime();
    const moved = { ...s, start: new Date(cursor), end: new Date(cursor + length) };
    cursor += length;
    return moved;
  });
}

/**
 * Two services of the client's visit at the same time, neither of them meant
 * to run alongside (parallel, e.g. while a colour sets). Null when none.
 */
export function clientDoubleBooked(services: VisitService[]): [VisitService, VisitService] | null {
  for (let i = 0; i < services.length; i++) {
    for (let j = i + 1; j < services.length; j++) {
      const a = services[i];
      const b = services[j];
      if (a.isParallel || b.isParallel) continue;
      if (a.start < b.end && b.start < a.end) return [a, b];
    }
  }
  return null;
}

/** The services whose time or professional changed. */
export function changedServices(before: VisitService[], after: VisitService[]): VisitService[] {
  return after.filter((s) => {
    const b = before.find((x) => x.id === s.id)!;
    return b.start.getTime() !== s.start.getTime() || b.end.getTime() !== s.end.getTime() || b.professionalId !== s.professionalId;
  });
}

/** First start to last end: the appointment's own time and length. */
export function visitSpan(services: VisitService[]): { start: Date; end: Date } {
  const start = Math.min(...services.map((s) => s.start.getTime()));
  const end = Math.max(...services.map((s) => s.end.getTime()));
  return { start: new Date(start), end: new Date(end) };
}
