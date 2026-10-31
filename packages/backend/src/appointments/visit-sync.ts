import { salonInstant } from "./salon-time";
import { salonDayAndTime } from "./reschedule-check";
import {
  VISIT_ROW_ORDER,
  VISIT_ROW_SELECT,
  VisitRow,
  VisitTotals,
  clockOf,
  endClock,
  normalizeAddons,
  visitTotals,
} from "./visit-totals";

/**
 * Keeps an appointment's own columns (time, duration, end, price) in step
 * with its service rows and add-ons, after anything changed them: a service
 * added, removed, cancelled or retimed. The figures come from visitTotals
 * (visit-totals.ts); this reads the rows and writes the result.
 *
 * `db` is the Prisma client or a transaction client.
 */

/** A visit that is history keeps the price it was charged and invoiced at. */
export function priceIsFrozen(apt: { status?: string | null; paymentStatus?: string | null }): boolean {
  return (
    ["completed", "cancelled", "no_show"].includes(String(apt.status)) ||
    ["paid", "refunded"].includes(String(apt.paymentStatus))
  );
}

/** The appointment columns these helpers read. */
export const VISIT_APPOINTMENT_SELECT = {
  id: true,
  tenantId: true,
  professionalId: true,
  scheduledDate: true,
  scheduledTime: true,
  startTime: true,
  duration: true,
  endTime: true,
  price: true,
  totalAmount: true,
  status: true,
  paymentStatus: true,
  addons: true,
  service: { select: { duration: true, price: true } },
  tenant: { select: { timezone: true } },
  services: { select: VISIT_ROW_SELECT, orderBy: VISIT_ROW_ORDER },
} as const;

/** The add-ons' services, priced: an add-on is a service of the salon's catalog. */
export async function addonServices(
  db: any,
  tenantId: string,
  raw: unknown,
): Promise<Array<{ quantity: number; service: { duration: number; price: unknown } | null }>> {
  const lines = normalizeAddons(raw);
  if (lines.length === 0) return [];
  const rows: Array<{ id: string; duration: number; price: unknown }> = await db.service.findMany({
    where: { tenantId, id: { in: [...new Set(lines.map((l) => l.addonId))] } },
    select: { id: true, duration: true, price: true },
  });
  return lines.map((l) => ({ quantity: l.quantity, service: rows.find((r) => r.id === l.addonId) ?? null }));
}

/**
 * The columns that put an appointment in step with `totals`. Only the ones
 * that differ, so an unchanged visit writes nothing. The start follows the
 * visit's first service (and the reminders with it); the price is left
 * alone on a visit that is history.
 */
export function visitColumns(
  apt: {
    scheduledDate: Date | string;
    scheduledTime: string;
    startTime?: Date | null;
    duration: number;
    endTime?: string | null;
    price?: unknown;
    totalAmount?: unknown;
    status?: string | null;
    paymentStatus?: string | null;
  },
  totals: VisitTotals,
  timeZone: string,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  const { day, time } = salonDayAndTime(totals.start, timeZone);
  const oldDay =
    typeof apt.scheduledDate === "string" ? apt.scheduledDate.slice(0, 10) : new Date(apt.scheduledDate).toISOString().slice(0, 10);
  if (day !== oldDay) data.scheduledDate = new Date(`${day}T00:00:00.000Z`);
  if (time !== apt.scheduledTime) data.scheduledTime = time;
  if (!apt.startTime || new Date(apt.startTime).getTime() !== totals.start.getTime()) {
    data.startTime = totals.start;
    data.reminder24hSent = false;
    data.reminder1hSent = false;
  }
  if (totals.durationMinutes !== apt.duration) data.duration = totals.durationMinutes;
  const endTime = endClock(time, totals.durationMinutes);
  if (endTime !== apt.endTime) data.endTime = endTime;
  if (!priceIsFrozen(apt)) {
    if (Math.round(Number(apt.price ?? 0) * 100) !== totals.totalCents) data.price = totals.price;
    if (Number(apt.totalAmount ?? 0) !== totals.totalCents) data.totalAmount = totals.totalCents;
  }
  return data;
}

/** The appointment's start, from its day and its time on the salon's clock. */
export function appointmentStart(
  apt: { scheduledDate: Date | string; scheduledTime: string },
  timeZone: string,
): Date {
  return salonInstant(apt.scheduledDate, clockOf(apt.scheduledTime, timeZone) ?? "00:00", timeZone);
}

/** Recompute and save an appointment's time, duration and price from its rows and add-ons. */
export async function syncVisitTotals(db: any, appointmentId: string): Promise<void> {
  const apt = await db.appointment.findUnique({ where: { id: appointmentId }, select: VISIT_APPOINTMENT_SELECT });
  if (!apt) return;
  const timeZone = apt.tenant?.timezone || "Europe/Madrid";
  const totals = visitTotals({
    start: appointmentStart(apt, timeZone),
    professionalId: apt.professionalId,
    mainService: apt.service,
    rows: (apt.services ?? []) as VisitRow[],
    addons: await addonServices(db, apt.tenantId, apt.addons),
  });
  const data = visitColumns(apt, totals, timeZone);
  if (Object.keys(data).length > 0) {
    await db.appointment.update({ where: { id: appointmentId }, data });
  }
}
