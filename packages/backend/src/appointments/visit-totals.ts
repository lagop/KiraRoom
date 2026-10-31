import { VisitService, currentVisitSchedule, visitSpan } from "./visit-move";
import { minutesOf } from "./working-hours";
import { salonInstant } from "./salon-time";

/**
 * What a visit (an appointment with one or more services) adds up to: how
 * long it takes, what it costs, and when each professional in it is busy.
 * Pure, on top of visit-move.ts's model of where each service sits. Tested
 * in visit-totals.spec.ts.
 *
 * A multi-service visit used to keep only its first service's duration and
 * price on the appointment. Availability read that one block, so the rest of
 * the visit (and the colleague doing the rinse after the colour) looked free
 * online; the POS and the invoice charged the first service only.
 *
 * - The appointment's duration runs from the visit's first service to its
 *   last one's end (parallel ones included), plus the add-ons' minutes.
 * - Its price is every service's price, plus every add-on's price times its
 *   quantity. Processing rows (a colour setting, the professional free) are
 *   time, not another service, and cost nothing; cancelled rows count for
 *   nothing at all.
 * - Each professional is busy during their own services; during a
 *   processing row nobody is.
 */

/** A row of `appointment_services` as these functions read it. */
export interface VisitRow {
  id: string;
  serviceId?: string;
  professionalId: string | null;
  scheduledStart: Date | null;
  scheduledEnd: Date | null;
  isParallel: boolean;
  /** active | processing | continuation */
  type?: string | null;
  status?: string | null;
  service?: { duration?: number | null; price?: unknown } | null;
}

/** The columns of a row these functions need, for Prisma selects. */
export const VISIT_ROW_SELECT = {
  id: true,
  serviceId: true,
  professionalId: true,
  scheduledStart: true,
  scheduledEnd: true,
  isParallel: true,
  type: true,
  status: true,
  service: { select: { duration: true, price: true } },
} as const;

/** The order a visit's rows are read in: the order the salon gave them. */
export const VISIT_ROW_ORDER = [{ order: "asc" }, { createdAt: "asc" }, { id: "asc" }] as const;

/** A cancelled service is no longer part of the visit. */
export function isLiveRow(row: Pick<VisitRow, "status">): boolean {
  return row.status !== "cancelled";
}

/** A processing row: the client waits (a colour setting), the professional is free. */
export function freesProfessional(row: Pick<VisitRow, "type">): boolean {
  return row.type === "processing";
}

/** Euros (a Decimal, a string, a number) to whole cents. */
export function toCents(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

/**
 * The end of something that starts at `start` ("HH:MM") and lasts
 * `minutes`, on the same clock. Saturates at 23:59: the column has no date,
 * and 23:30 + 60 min used to read 00:30 -- before it started. A visit that
 * really runs past midnight is refused by the reschedule check anyway.
 */
export function endClock(start: string, minutes: number): string {
  const from = minutesOf(start);
  if (from === null) return start;
  const end = Math.min(from + Math.max(0, Math.round(minutes || 0)), 24 * 60 - 1);
  return `${String(Math.floor(end / 60)).padStart(2, "0")}:${String(end % 60).padStart(2, "0")}`;
}

/**
 * "HH:MM" from an appointment's scheduledTime. Reorder and toggle-parallel
 * used to write an ISO instant there ("2026-11-02T09:00:00.000Z"); rows
 * saved that way are read as the salon's clock at that instant.
 */
export function clockOf(scheduledTime: string, timeZone: string): string | null {
  if (minutesOf(scheduledTime) !== null) return scheduledTime.trim();
  const hms = /^(\d{1,2}):(\d{2}):\d{2}$/.exec(scheduledTime.trim());
  if (hms) return `${hms[1].padStart(2, "0")}:${hms[2]}`;
  const instant = new Date(scheduledTime);
  if (/^\d{4}-\d{2}-\d{2}T/.test(scheduledTime) && !isNaN(instant.getTime())) {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(instant);
    const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
    return `${get("hour")}:${get("minute")}`;
  }
  return null;
}

/** Where each live service of the visit sits (visit-move.ts's model). */
export function visitSchedule(start: Date, professionalId: string, rows: VisitRow[]): VisitService[] {
  return currentVisitSchedule({
    appointmentStart: start,
    appointmentProfessionalId: professionalId,
    services: rows.filter(isLiveRow).map((r) => ({
      id: r.id,
      professionalId: r.professionalId,
      scheduledStart: r.scheduledStart,
      scheduledEnd: r.scheduledEnd,
      isParallel: !!r.isParallel,
      durationMinutes: Number(r.service?.duration) || 0,
    })),
  });
}

/**
 * The visit laid out again from `start`, in the given order: serial services
 * one after another, parallel ones alongside from the start -- how the
 * calendar draws a visit without stored times. Each keeps its length. For
 * reordering and switching a service between serial and parallel, where the
 * old times no longer mean anything.
 */
export function layoutVisit(start: Date, services: VisitService[]): VisitService[] {
  return currentVisitSchedule({
    appointmentStart: start,
    appointmentProfessionalId: "",
    services: services.map((s) => ({
      id: s.id,
      professionalId: s.professionalId,
      scheduledStart: null,
      scheduledEnd: null,
      isParallel: s.isParallel,
      durationMinutes: Math.round((s.end.getTime() - s.start.getTime()) / 60_000),
    })),
  });
}

/* -------------------------------------------------------------------------- */
/*  Add-ons                                                                   */
/* -------------------------------------------------------------------------- */

export interface AddonLine {
  addonId: string;
  quantity: number;
}

/**
 * The add-ons column as a plain list. Edits stored it as `{"set": [...]}`
 * (a Prisma relation verb written into a Json column), which the panel
 * could not read; old rows still hold that, or a `{ id: quantity }` map.
 */
export function normalizeAddons(raw: unknown): AddonLine[] {
  let list: unknown[] = [];
  if (Array.isArray(raw)) {
    list = raw;
  } else if (raw && typeof raw === "object") {
    const set = (raw as { set?: unknown }).set;
    list = Array.isArray(set)
      ? set
      : Object.entries(raw as Record<string, unknown>).map(([addonId, quantity]) => ({ addonId, quantity }));
  }
  const out: AddonLine[] = [];
  for (const item of list.flat()) {
    if (!item || typeof item !== "object") continue;
    const id = (item as any).addonId ?? (item as any).serviceId;
    if (typeof id !== "string" || !id) continue;
    const q = Number((item as any).quantity ?? 1);
    out.push({ addonId: id, quantity: Number.isFinite(q) && q >= 1 ? Math.floor(q) : 1 });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/*  Totals                                                                    */
/* -------------------------------------------------------------------------- */

export interface VisitTotals {
  /** The live services where they sit (empty for a single-service appointment). */
  schedule: VisitService[];
  /** First service's start to last one's end; the appointment's start without rows. */
  start: Date;
  durationMinutes: number;
  servicesCents: number;
  addonsCents: number;
  totalCents: number;
  /** totalCents in euros, for the `price` column. */
  price: number;
}

export function visitTotals(input: {
  /** The appointment's start (its day and time on the salon's clock). */
  start: Date;
  professionalId: string;
  /** The appointment's own service: the visit when it has no live rows. */
  mainService: { duration?: number | null; price?: unknown } | null;
  rows: VisitRow[];
  addons?: Array<{ quantity: number; service: { duration?: number | null; price?: unknown } | null }>;
}): VisitTotals {
  const live = input.rows.filter(isLiveRow);
  let schedule: VisitService[] = [];
  let start = input.start;
  let minutes: number;
  let servicesCents: number;
  if (live.length > 0) {
    schedule = visitSchedule(input.start, input.professionalId, live);
    const span = visitSpan(schedule);
    start = span.start;
    minutes = Math.round((span.end.getTime() - span.start.getTime()) / 60_000);
    servicesCents = live.filter((r) => !freesProfessional(r)).reduce((sum, r) => sum + toCents(r.service?.price), 0);
  } else {
    minutes = Number(input.mainService?.duration) || 0;
    servicesCents = toCents(input.mainService?.price);
  }
  let addonsCents = 0;
  for (const a of input.addons ?? []) {
    if (!a.service) continue;
    addonsCents += toCents(a.service.price) * a.quantity;
    minutes += (Number(a.service.duration) || 0) * a.quantity;
  }
  const totalCents = servicesCents + addonsCents;
  return {
    schedule,
    start,
    durationMinutes: minutes,
    servicesCents,
    addonsCents,
    totalCents,
    price: totalCents / 100,
  };
}

/* -------------------------------------------------------------------------- */
/*  Who is busy when                                                          */
/* -------------------------------------------------------------------------- */

/** A professional busy from `startMinutes` to `endMinutes` on the salon's clock that day. */
export interface BusyBlock {
  professionalId: string;
  startMinutes: number;
  endMinutes: number;
}

/**
 * When each professional of an appointment is busy, in minutes of the
 * salon's day. Without service rows: its professional, from its time for
 * its duration. With rows: each service's professional during that service
 * (the rinse after the colour may be a colleague's), nobody during a
 * processing row, and its own professional for whatever of the
 * appointment's duration runs past its services (add-ons).
 *
 * `day` is the appointment's day when the row lacks scheduledDate.
 */
export function appointmentBusyBlocks(
  apt: {
    professionalId: string;
    scheduledDate?: Date | string | null;
    scheduledTime: string;
    duration: number;
    services?: VisitRow[] | null;
  },
  timeZone: string,
  day?: string,
): BusyBlock[] {
  const clock = clockOf(apt.scheduledTime ?? "", timeZone);
  if (clock === null) return [];
  const startMinutes = minutesOf(clock)!;
  const duration = Number(apt.duration) || 0;
  const live = (apt.services ?? []).filter(isLiveRow);
  if (live.length === 0) {
    return [{ professionalId: apt.professionalId, startMinutes, endMinutes: startMinutes + duration }];
  }

  const dayOf = apt.scheduledDate
    ? typeof apt.scheduledDate === "string"
      ? apt.scheduledDate.slice(0, 10)
      : apt.scheduledDate.toISOString().slice(0, 10)
    : day;
  const start = dayOf ? salonInstant(dayOf, clock, timeZone) : new Date(Date.UTC(2000, 0, 1, 0, startMinutes));
  const at = (d: Date) => startMinutes + Math.round((d.getTime() - start.getTime()) / 60_000);

  const schedule = visitSchedule(start, apt.professionalId, live);
  const blocks: BusyBlock[] = [];
  let rowsEnd = startMinutes;
  schedule.forEach((s, i) => {
    rowsEnd = Math.max(rowsEnd, at(s.end));
    if (freesProfessional(live[i])) return;
    blocks.push({ professionalId: s.professionalId, startMinutes: at(s.start), endMinutes: at(s.end) });
  });
  if (startMinutes + duration > rowsEnd) {
    blocks.push({ professionalId: apt.professionalId, startMinutes: rowsEnd, endMinutes: startMinutes + duration });
  }
  return blocks;
}

/** Whether a block overlaps `[from, from + minutes)`. Back to back is not an overlap. */
export function overlapsBlock(block: BusyBlock, from: number, minutes: number): boolean {
  return block.startMinutes < from + minutes && from < block.endMinutes;
}

/* -------------------------------------------------------------------------- */
/*  What the client is charged, line by line                                  */
/* -------------------------------------------------------------------------- */

export interface VisitLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  serviceId?: string;
}

/**
 * The visit as invoice or POS lines: one per service (its own service when
 * it has no live rows), one per add-on with its quantity. They add up to
 * visitTotals' totalCents. For the auto-invoice, which charged the first
 * service's line only.
 */
export function visitLines(input: {
  mainService: { id?: string; name?: string | null; price?: unknown } | null;
  rows: Array<VisitRow & { service?: { name?: string | null; duration?: number | null; price?: unknown } | null }>;
  addons?: Array<{ quantity: number; service: { id?: string; name?: string | null; price?: unknown } | null }>;
}): VisitLine[] {
  const live = input.rows.filter(isLiveRow).filter((r) => !freesProfessional(r));
  const lines: VisitLine[] =
    live.length > 0
      ? live.map((r) => ({
          description: r.service?.name || "Servicio",
          quantity: 1,
          unitPriceCents: toCents(r.service?.price),
          serviceId: r.serviceId,
        }))
      : input.rows.filter(isLiveRow).length > 0
        ? []
        : [
            {
              description: input.mainService?.name || "Servicio",
              quantity: 1,
              unitPriceCents: toCents(input.mainService?.price),
              serviceId: input.mainService?.id,
            },
          ];
  for (const a of input.addons ?? []) {
    if (!a.service) continue;
    lines.push({
      description: a.service.name || "Extra",
      quantity: a.quantity,
      unitPriceCents: toCents(a.service.price),
      serviceId: a.service.id,
    });
  }
  return lines;
}
