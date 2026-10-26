import { ConflictException } from "@nestjs/common";
import { AppointmentStatus } from "@prisma/client";
import { fitsInWindow, minutesOf, workingWindowFor } from "./working-hours";
import { salonInstant } from "./salon-time";

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
 * recorded means no limit), the salon's opening hours when it set them, and
 * the professional's other appointments that day, cancelled ones aside.
 */

export interface RescheduleTarget {
  tenantId: string;
  /** The appointment being moved: never a clash with itself. */
  appointmentId: string;
  professionalId: string;
  /** YYYY-MM-DD, the salon's calendar day. */
  day: string;
  /** HH:MM, the salon's clock. */
  time: string;
  durationMinutes: number;
}

type Busy = { scheduledTime: string; duration: number; clientName?: string | null };

/** The reason a move cannot be made, in the words the salon reads; null when it can. */
export function rescheduleProblem(input: {
  startMinutes: number | null;
  durationMinutes: number;
  /** workingWindowFor: undefined = no schedule, null = not working that day. */
  professionalWindow: { startMinutes: number; endMinutes: number } | null | undefined;
  professionalName: string;
  salonWindow?: { startMinutes: number; endMinutes: number };
  others: Busy[];
  inPast: boolean;
}): string | null {
  const { startMinutes, durationMinutes } = input;
  if (startMinutes === null) return "La hora no es válida.";
  if (input.inPast) return "No se puede mover una cita a un momento que ya ha pasado.";
  if (startMinutes + durationMinutes > 24 * 60) return "La cita terminaría al día siguiente.";
  if (input.professionalWindow === null) {
    return `${input.professionalName} no trabaja ese día.`;
  }
  if (input.professionalWindow && !fitsInWindow(startMinutes, durationMinutes, input.professionalWindow)) {
    return `Está fuera del horario de ${input.professionalName} (${clock(input.professionalWindow.startMinutes)}–${clock(input.professionalWindow.endMinutes)}).`;
  }
  if (input.salonWindow && !fitsInWindow(startMinutes, durationMinutes, input.salonWindow)) {
    return `Está fuera del horario del salón (${clock(input.salonWindow.startMinutes)}–${clock(input.salonWindow.endMinutes)}).`;
  }
  const end = startMinutes + durationMinutes;
  const clash = input.others.find((o) => {
    const s = minutesOf(o.scheduledTime);
    if (s === null) return false;
    return s < end && startMinutes < s + o.duration;
  });
  if (clash) {
    const who = clash.clientName ? ` con ${clash.clientName}` : "";
    return `${input.professionalName} ya tiene una cita${who} a las ${clash.scheduledTime}.`;
  }
  return null;
}

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

type PrismaLike = {
  tenant: { findUnique: (args: any) => Promise<any> };
  professional: { findFirst: (args: any) => Promise<any> };
  appointment: { findMany: (args: any) => Promise<any[]> };
};

/** Throws a 409 with the reason when the move is not possible. */
export async function assertCanReschedule(
  prisma: PrismaLike,
  target: RescheduleTarget,
  now: Date = new Date(),
): Promise<void> {
  const [tenant, professional, others] = await Promise.all([
    prisma.tenant.findUnique({
      where: { id: target.tenantId },
      select: { openingHours: true, timezone: true },
    }),
    prisma.professional.findFirst({
      where: { id: target.professionalId, tenantId: target.tenantId },
      select: { firstName: true, lastName: true, workingHours: true },
    }),
    prisma.appointment.findMany({
      where: {
        tenantId: target.tenantId,
        professionalId: target.professionalId,
        id: { not: target.appointmentId },
        scheduledDate: {
          gte: new Date(`${target.day}T00:00:00.000Z`),
          lte: new Date(`${target.day}T23:59:59.999Z`),
        },
        status: { not: AppointmentStatus.cancelled },
      },
      select: {
        scheduledTime: true,
        duration: true,
        client: { select: { firstName: true, lastName: true } },
      },
    }),
  ]);
  if (!professional) throw new ConflictException("Ese profesional no existe en este salón.");

  const hours = (tenant?.openingHours ?? {}) as { open?: string; close?: string };
  const open = hours.open ? minutesOf(hours.open) : null;
  const close = hours.close ? minutesOf(hours.close) : null;
  const timeZone = tenant?.timezone || "Europe/Madrid";

  const problem = rescheduleProblem({
    startMinutes: minutesOf(target.time),
    durationMinutes: target.durationMinutes,
    professionalWindow: workingWindowFor(professional.workingHours, new Date(`${target.day}T12:00:00.000Z`)),
    professionalName: professional.firstName,
    salonWindow: open !== null && close !== null && close > open ? { startMinutes: open, endMinutes: close } : undefined,
    others: others.map((o) => ({
      scheduledTime: o.scheduledTime,
      duration: o.duration,
      clientName: o.client ? `${o.client.firstName} ${o.client.lastName}`.trim() : null,
    })),
    inPast: minutesOf(target.time) !== null && salonInstant(target.day, target.time, timeZone) < now,
  });
  if (problem) throw new ConflictException(problem);
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
