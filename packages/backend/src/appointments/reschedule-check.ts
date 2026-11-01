import { ConflictException } from "@nestjs/common";
import { AppointmentStatus } from "@prisma/client";
import {
  ShiftWindow,
  clockOf,
  describeShifts,
  fitsInShifts,
  minutesOf,
  salonWindowsFor,
  workingWindowsFor,
} from "./working-hours";
import { salonInstant } from "./salon-time";
import { VISIT_ROW_ORDER, VISIT_ROW_SELECT, appointmentBusyBlocks } from "./visit-totals";
import { timeOffProblem } from "../time-off/time-off-rules";
import { timeOffBetween } from "../time-off/time-off-query";

/**
 * Whether an appointment may be moved to a new day, time or professional:
 * from the calendar by dragging, or from the edit form. Nothing checked this,
 * so an appointment could be dropped on top of another one of the same
 * professional, outside their hours or in the past, and was saved.
 *
 * Moves are refused, not warned about: an overlap made by mistake is a double
 * booking the salon finds out about when two clients arrive.
 *
 * The same rules as online availability (getAvailableSlots), on 15-minute
 * steps rather than its 30-minute slots: the professional's schedule (none
 * recorded means no limit), their time off and the salon's closures
 * (time-off-rules.ts), the salon's opening hours when it set them (its own
 * week, shifts included: closed on a weekday without hours), and the
 * professional's other appointments that day, cancelled ones aside.
 *
 * "Other appointments" means every block of time the professional is busy:
 * their own appointments, and the services they do in a colleague's visit
 * (the rinse after a colour). A multi-service visit used to count as its
 * first service only, for its main professional only (visit-totals.ts).
 *
 * Busy also covers the cleanup after each visit ("tiempo de limpieza",
 * Service.bufferTime, 0 = none): nothing may start inside it, and the
 * cleanup of the appointment being booked or moved (cleanupMinutes) may not
 * run into the next one. The visit has to end by closing time; its cleanup
 * may run past it.
 */

export interface RescheduleTarget {
  tenantId: string;
  /** The appointment being moved: never a clash with itself. Absent for a new one. */
  appointmentId?: string;
  professionalId: string;
  /** YYYY-MM-DD, the salon's calendar day. */
  day: string;
  /** HH:MM, the salon's clock. */
  time: string;
  durationMinutes: number;
  /**
   * The cleanup after it ("tiempo de limpieza", Service.bufferTime), when
   * this is the service its visit ends with (visit-totals.ts plannedCleanup):
   * it may not run into the professional's next appointment. Not part of
   * the hours: the visit has to end by closing time, its cleanup may run
   * past it.
   */
  cleanupMinutes?: number;
}

export type Busy = {
  scheduledTime: string;
  duration: number;
  clientName?: string | null;
  /** Minutes of the day, when known; else read from scheduledTime. */
  startMinutes?: number;
  /** The cleanup after another visit, not the visit itself. */
  cleanup?: boolean;
};

/**
 * The reason a move cannot be made, in the words the salon reads; null when it can.
 *
 * `skipHours` leaves out the past and the working and opening hours, and
 * keeps what is never allowed (a bad time, running into the next day, an
 * overlap): an owner may book a walk-in outside hours, never a double booking.
 */
export function rescheduleProblem(input: {
  startMinutes: number | null;
  durationMinutes: number;
  /**
   * workingWindowsFor: undefined = no schedule, [] = not working that day,
   * else that day's shifts. The appointment has to fit inside one of them.
   */
  professionalShifts: ShiftWindow[] | undefined;
  professionalName: string;
  /**
   * salonWindowsFor: undefined = the salon set no hours, [] = closed that
   * weekday, else its open stretches. Like a shift, the appointment has to
   * fit inside one of them.
   */
  salonShifts?: ShiftWindow[];
  /**
   * Why time off or a salon closure blocks this slot (timeOffProblem), if it
   * does. One of "the hours": an owner may confirm a booking past it, as
   * outside a shift; a move never.
   */
  timeOff?: string | null;
  others: Busy[];
  inPast: boolean;
  /** "create" for a new appointment: only changes the wording. */
  action?: "move" | "create";
  skipHours?: boolean;
  /** RescheduleTarget.cleanupMinutes: blocks the agenda after it, not the hours. */
  cleanupMinutes?: number;
}): string | null {
  const { startMinutes, durationMinutes } = input;
  const hours = !input.skipHours;
  if (startMinutes === null) return "La hora no es válida.";
  if (hours && input.inPast) {
    return input.action === "create"
      ? "No se puede crear una cita en un momento que ya ha pasado."
      : "No se puede mover una cita a un momento que ya ha pasado.";
  }
  if (startMinutes + durationMinutes > 24 * 60) return "La cita terminaría al día siguiente.";
  // Before the shifts: "Ana está de vacaciones" says more than "no trabaja".
  if (hours && input.timeOff) return input.timeOff;
  const salon = input.salonShifts;
  if (hours && salon && salon.length === 0) return "El salón está cerrado ese día.";
  const shifts = input.professionalShifts;
  if (hours && shifts && shifts.length === 0) {
    return `${input.professionalName} no trabaja ese día.`;
  }
  // Every shift is named, so with a split day the salon reads why 13:30 for
  // an hour was refused: "(10:00–14:00 y 17:00–20:00)".
  if (hours && shifts && !fitsInShifts(startMinutes, durationMinutes, shifts)) {
    return `Está fuera del horario de ${input.professionalName} (${describeShifts(shifts)}).`;
  }
  if (hours && salon && !fitsInShifts(startMinutes, durationMinutes, salon)) {
    return `Está fuera del horario del salón (${describeShifts(salon)}).`;
  }
  // The professional is busy until the end of the visit plus its cleanup
  // (cleanupMinutes): it may not start inside another visit or the cleanup
  // after it, and its own cleanup may not run into the next visit.
  const end = startMinutes + durationMinutes;
  const cleanup = Math.max(0, Math.round(input.cleanupMinutes ?? 0));
  const startOf = (o: Busy) => o.startMinutes ?? minutesOf(o.scheduledTime);
  const clashes = input.others.filter((o) => {
    const s = startOf(o);
    if (s === null) return false;
    return s < end + cleanup && startMinutes < s + o.duration;
  });
  if (clashes.length === 0) return null;
  // The visit itself on top of another one says the most; then a cleanup.
  const clash =
    clashes.find((o) => !o.cleanup && startOf(o)! < end) ?? clashes.find((o) => !o.cleanup) ?? clashes[0];
  const who = clash.clientName ? ` con ${clash.clientName}` : "";
  if (clash.cleanup) {
    const until = clock(Math.min(24 * 60 - 1, startOf(clash)! + clash.duration));
    return `${input.professionalName} tiene tiempo de limpieza hasta las ${until} después de su cita${who}.`;
  }
  if (startOf(clash)! >= end) {
    return `${input.professionalName} ya tiene una cita${who} a las ${clash.scheduledTime}: no quedarían los ${cleanup} min de limpieza después de esta.`;
  }
  return `${input.professionalName} ya tiene una cita${who} a las ${clash.scheduledTime}.`;
}

const clock = clockOf;

type PrismaLike = {
  tenant: { findUnique: (args: any) => Promise<any> };
  professional: { findFirst: (args: any) => Promise<any> };
  appointment: { findMany: (args: any) => Promise<any[]> };
  timeOff: { findMany: (args: any) => Promise<any[]> };
};

/**
 * A professional's busy time on a salon day, from other appointments: their
 * own, and their services in a colleague's visit (visit-totals.ts). For the
 * reschedule and booking checks here, and any other check that books a
 * slot. `timeZone` is the salon's.
 */
export async function professionalBusyTime(
  prisma: Pick<PrismaLike, "appointment">,
  q: { tenantId: string; professionalId: string; day: string; timeZone: string; excludeAppointmentId?: string },
): Promise<Busy[]> {
  const others = await prisma.appointment.findMany({
    where: {
      tenantId: q.tenantId,
      ...(q.excludeAppointmentId ? { id: { not: q.excludeAppointmentId } } : {}),
      OR: [{ professionalId: q.professionalId }, { services: { some: { professionalId: q.professionalId } } }],
      scheduledDate: {
        gte: new Date(`${q.day}T00:00:00.000Z`),
        lte: new Date(`${q.day}T23:59:59.999Z`),
      },
      status: { not: AppointmentStatus.cancelled },
    },
    select: {
      professionalId: true,
      scheduledDate: true,
      scheduledTime: true,
      duration: true,
      client: { select: { firstName: true, lastName: true } },
      // Its cleanup time (appointmentBusyBlocks); the rows' is in VISIT_ROW_SELECT.
      service: { select: { bufferTime: true } },
      services: { select: VISIT_ROW_SELECT, orderBy: VISIT_ROW_ORDER as any },
    },
  });
  return others.flatMap((o) =>
    appointmentBusyBlocks(o, q.timeZone, q.day)
      .filter((b) => b.professionalId === q.professionalId)
      .map((b) => ({
        scheduledTime: clock(Math.max(0, b.startMinutes)),
        startMinutes: b.startMinutes,
        duration: b.endMinutes - b.startMinutes,
        clientName: o.client ? `${o.client.firstName} ${o.client.lastName}`.trim() : null,
        ...(b.cleanup ? { cleanup: true } : {}),
      })),
  );
}

/** Throws a 409 with the reason when the move is not possible. */
export async function assertCanReschedule(
  prisma: PrismaLike,
  target: RescheduleTarget,
  now: Date = new Date(),
): Promise<void> {
  const problem = rescheduleProblem(await scheduleCheckInput(prisma, target, now));
  if (problem) throw new ConflictException(problem);
}

/** A new appointment overlaps another of the professional's (or cannot be at that time at all). */
export const SCHEDULE_CONFLICT = "SCHEDULE_CONFLICT";
/** A new appointment is in the past or outside the hours: an owner or manager may confirm it. */
export const OUTSIDE_HOURS = "OUTSIDE_HOURS";

/**
 * Whether a new appointment fits the professional's agenda: the same rules as
 * a move. An overlap is always refused (409, code SCHEDULE_CONFLICT). The past,
 * the hours, time off and salon closures are refused with code OUTSIDE_HOURS
 * unless `allowOutsideHours`, which the caller grants only to owners and
 * managers who confirmed it (a walk-in, or entering yesterday's visit
 * afterwards). Online bookings and the receptionist never come through here:
 * they book what getAvailableSlots offers, which never includes time off.
 *
 * "The past" allows a few minutes' grace: a walk-in entered as it starts
 * is a booking for now, not a catch-up entry.
 */
export async function assertCanBook(
  prisma: PrismaLike,
  target: RescheduleTarget,
  opts: { allowOutsideHours?: boolean; now?: Date } = {},
): Promise<void> {
  const now = (opts.now ?? new Date()).getTime() - PAST_GRACE_MINUTES * 60_000;
  const input = { ...(await scheduleCheckInput(prisma, target, new Date(now))), action: "create" as const };
  const clash = rescheduleProblem({ ...input, skipHours: true });
  if (clash) throw new ConflictException({ code: SCHEDULE_CONFLICT, message: clash });
  if (opts.allowOutsideHours) return;
  const outside = rescheduleProblem(input);
  if (outside) throw new ConflictException({ code: OUTSIDE_HOURS, message: outside });
}

const PAST_GRACE_MINUTES = 15;

async function scheduleCheckInput(
  prisma: PrismaLike,
  target: RescheduleTarget,
  now: Date,
): Promise<Parameters<typeof rescheduleProblem>[0]> {
  const [tenant, professional] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: target.tenantId },
      select: { openingHours: true, timezone: true },
    }),
    prisma.professional.findFirst({
      where: { id: target.professionalId, tenantId: target.tenantId },
      select: { firstName: true, lastName: true, workingHours: true },
    }),
  ]);
  if (!professional) throw new ConflictException("Ese profesional no existe en este salón.");

  const timeZone = tenant?.timezone || "Europe/Madrid";
  const [others, timeOff] = await Promise.all([
    professionalBusyTime(prisma, {
      tenantId: target.tenantId,
      professionalId: target.professionalId,
      day: target.day,
      timeZone,
      excludeAppointmentId: target.appointmentId,
    }),
    timeOffBetween(prisma, target.tenantId, target.day),
  ]);
  const startMinutes = minutesOf(target.time);
  const noon = new Date(`${target.day}T12:00:00.000Z`);

  return {
    startMinutes,
    durationMinutes: target.durationMinutes,
    cleanupMinutes: target.cleanupMinutes,
    professionalShifts: workingWindowsFor(professional.workingHours, noon),
    professionalName: professional.firstName,
    salonShifts: salonWindowsFor(tenant?.openingHours, noon),
    timeOff:
      startMinutes === null
        ? null
        : timeOffProblem({
            blocks: timeOff,
            day: target.day,
            professionalId: target.professionalId,
            professionalName: professional.firstName,
            startMinutes,
            durationMinutes: target.durationMinutes,
          }),
    others,
    inPast: minutesOf(target.time) !== null && salonInstant(target.day, target.time, timeZone) < now,
  };
}

/** The salon's calendar day and clock for an instant (service rows store instants). */
export function salonDayAndTime(instant: Date, timeZone: string): { day: string; time: string } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${get("minute")}` };
}
