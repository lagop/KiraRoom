/**
 * The day the calendar is on, and how its grid is laid out. Pure, so it is
 * tested without a browser (day-grid.spec.ts).
 *
 * The day used to travel as a Date built from "YYYY-MM-DD" with `new Date()`
 * (UTC midnight) and back with `toISOString()` (UTC again). Read on a local
 * clock that is a different day on either side of UTC: in America the
 * calendar opened on yesterday, and in Madrid "next day" from 29 March 2026
 * landed on 29 March again (the clocks went forward) and skipped 25 October.
 * A day is a "yyyy-MM-dd" string here, turned into a Date only at the local
 * midnight it stands for, and moved with calendar arithmetic.
 */
import { addDays, format } from "date-fns";
import { calendarLabel, type TimeOff } from "../../lib/time-off";

/** 15 minutes of grid. */
export const SLOT_HEIGHT = 24;
export const HOUR_HEIGHT = SLOT_HEIGHT * 4;
/** The professionals' row above the hours. */
export const HEADER_HEIGHT = 48;
/** When neither the salon nor its professionals say when they work. */
export const DEFAULT_HOURS: HoursRange = { startHour: 8, endHour: 20 };

/** "yyyy-MM-dd" of `date` on the browser's calendar (today by default). */
export function localDay(date: Date = new Date()): string {
  return format(date, "yyyy-MM-dd");
}

/** The browser's local midnight of `day` ("yyyy-MM-dd"). */
export function dateOfDay(day: string): Date {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** `day` moved by `delta` calendar days, whatever the clocks do in between. */
export function shiftDay(day: string, delta: number): string {
  return localDay(addDays(dateOfDay(day), delta));
}

export interface HoursRange {
  /** First hour drawn. */
  startHour: number;
  /** Hour the grid ends at (exclusive). */
  endHour: number;
}

/** Minutes since midnight for "HH:MM", or null. */
function minutesOf(time: unknown): number | null {
  if (typeof time !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 24 || minutes > 59) return null;
  return hours * 60 + minutes;
}

const WEEKDAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];

/** A professional's working hours, as the onboarding stores them. */
export interface WorkingHoursEntry {
  day?: unknown;
  openTime?: unknown;
  closeTime?: unknown;
}

/**
 * The hours the grid draws for `day`.
 *
 * The salon's opening hours (Tenant.openingHours, one `{ open, close }` for
 * the week) and each professional's working hours for that weekday, when
 * there are any; 08:00 to 20:00 otherwise. Then widened to cover every
 * appointment of the day, so none is ever drawn off the grid.
 */
export function gridHours(input: {
  day: string;
  openingHours?: { open?: unknown; close?: unknown } | null;
  workingHours?: unknown[][];
  /** Appointments of the day as minutes since the salon's midnight. */
  appointments?: { start: number; end: number }[];
}): HoursRange {
  const windows: { start: number; end: number }[] = [];
  const open = minutesOf(input.openingHours?.open);
  const close = minutesOf(input.openingHours?.close);
  if (open !== null && close !== null && close > open) windows.push({ start: open, end: close });

  const weekday = WEEKDAYS[dateOfDay(input.day).getDay()];
  for (const entries of input.workingHours ?? []) {
    if (!Array.isArray(entries)) continue;
    for (const entry of entries as WorkingHoursEntry[]) {
      if (!entry || typeof entry.day !== "string" || entry.day.toLowerCase() !== weekday) continue;
      const start = minutesOf(entry.openTime);
      const end = minutesOf(entry.closeTime);
      if (start !== null && end !== null && end > start) windows.push({ start, end });
    }
  }

  let startHour = DEFAULT_HOURS.startHour;
  let endHour = DEFAULT_HOURS.endHour;
  if (windows.length > 0) {
    startHour = Math.floor(Math.min(...windows.map((w) => w.start)) / 60);
    endHour = Math.ceil(Math.max(...windows.map((w) => w.end)) / 60);
  }
  for (const a of input.appointments ?? []) {
    startHour = Math.min(startHour, Math.floor(a.start / 60));
    endHour = Math.max(endHour, Math.ceil(a.end / 60));
  }
  startHour = Math.max(0, startHour);
  endHour = Math.min(24, Math.max(endHour, startHour + 1));
  return { startHour, endHour };
}

/** A stretch of the day, in minutes since midnight. */
export interface MinuteRange {
  start: number;
  end: number;
}

/**
 * A professional's shifts on `day`, sorted and with touching or overlapping
 * ones joined, or `undefined` when no schedule is recorded at all.
 *
 * The same reading as the server's workingWindowsFor (working-hours.ts):
 * several entries for one weekday are several shifts (jornada partida), a
 * malformed entry is skipped, and a schedule with nothing valid for the day
 * means the day off -- `[]`, not "no limit".
 */
export function shiftsOn(day: string, workingHours: unknown): MinuteRange[] | undefined {
  if (!Array.isArray(workingHours)) return undefined;
  const entries = (workingHours as WorkingHoursEntry[]).filter(
    (e) =>
      !!e &&
      typeof e === "object" &&
      typeof e.day === "string" &&
      typeof e.openTime === "string" &&
      typeof e.closeTime === "string",
  );
  if (entries.length === 0) return undefined;

  const weekday = WEEKDAYS[dateOfDay(day).getDay()];
  const windows: MinuteRange[] = [];
  for (const entry of entries) {
    if ((entry.day as string).toLowerCase() !== weekday) continue;
    const start = minutesOf(entry.openTime);
    const end = minutesOf(entry.closeTime);
    if (start !== null && end !== null && end > start) windows.push({ start, end });
  }
  windows.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: MinuteRange[] = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else merged.push({ ...w });
  }
  return merged;
}

/**
 * The parts of the drawn hours a professional is NOT working on `day`, to
 * shade in their column: before the first shift, after the last, and the gap
 * between shifts (the lunch of a split day), so the calendar shows the same
 * hours online booking offers.
 *
 * Nothing is shaded when no schedule is recorded: online booking puts no
 * limit on those professionals either, and greying their whole day would say
 * the opposite. A day off is shaded entirely.
 */
export function offShiftBands(day: string, workingHours: unknown, range: HoursRange): MinuteRange[] {
  const shifts = shiftsOn(day, workingHours);
  if (!shifts) return [];
  const top = range.startHour * 60;
  const bottom = range.endHour * 60;
  const bands: MinuteRange[] = [];
  let cursor = top;
  for (const s of shifts) {
    if (s.start > cursor) bands.push({ start: cursor, end: Math.min(s.start, bottom) });
    cursor = Math.max(cursor, s.end);
  }
  if (cursor < bottom) bands.push({ start: cursor, end: bottom });
  return bands.filter((b) => b.end > b.start);
}

/** A stretch of a column covered by time off or a salon closure. */
export interface TimeOffBand extends MinuteRange {
  label: string;
  /** The salon is closed (drawn across every column), not one person away. */
  salon: boolean;
}

type CalendarTimeOff = Pick<TimeOff, "professionalId" | "kind" | "startDate" | "endDate" | "startTime" | "endTime" | "note">;

/**
 * The time off and closures to shade in a professional's column on `day`,
 * clipped to the drawn hours: the salon's closures and the professional's own
 * blocks, all day or their hours. Shaded, not blocked, like the time outside
 * a shift: an owner may still book a walk-in there (the server asks them to
 * confirm it), so clicks pass through.
 */
export function timeOffBands(
  day: string,
  professionalId: string,
  blocks: ReadonlyArray<CalendarTimeOff>,
  range: HoursRange,
): TimeOffBand[] {
  const top = range.startHour * 60;
  const bottom = range.endHour * 60;
  const bands: TimeOffBand[] = [];
  for (const b of blocks) {
    if (b.professionalId !== null && b.professionalId !== professionalId) continue;
    if (!(b.startDate <= day && day <= b.endDate)) continue;
    // No hours: the whole day. An unreadable hour is read as the day's edge.
    const from = b.startTime ? (minutesOf(b.startTime) ?? 0) : 0;
    const to = b.endTime ? (minutesOf(b.endTime) ?? 24 * 60) : 24 * 60;
    const start = Math.max(top, from);
    const end = Math.min(bottom, to);
    if (end <= start) continue;
    bands.push({ start, end, label: calendarLabel(b), salon: b.professionalId === null });
  }
  // The salon's first, so its label is the one on top when they overlap.
  return bands.sort((a, b) => Number(b.salon) - Number(a.salon) || a.start - b.start);
}

/** The salon's all-day closure on `day`, if any: the calendar says so above the grid. */
export function salonClosureOn<T extends CalendarTimeOff>(day: string, blocks: ReadonlyArray<T>): T | null {
  return blocks.find((b) => b.professionalId === null && !b.startTime && b.startDate <= day && day <= b.endDate) ?? null;
}

/** Pixels from the top of the hours (below the professionals' row). */
export function minutesToTop(minutes: number, startHour: number): number {
  return ((minutes - startHour * 60) / 15) * SLOT_HEIGHT;
}

/**
 * A cancelled appointment, or one the client did not come to, no longer holds
 * its slot: the calendar must not draw it over the booking that took it.
 */
export function holdsSlot(status?: string): boolean {
  return status !== "cancelled" && status !== "no_show";
}

/**
 * A lunch or a break, by its service name. It only knew English ("lunch",
 * "break"), and the salons name their services in Spanish.
 */
export function isBreakService(name?: string): boolean {
  if (!name) return false;
  const n = name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  return /\b(lunch|break|comida|almuerzo|descanso|pausa)\b/.test(n);
}

export interface Lane {
  /** 0-based position from the left. */
  lane: number;
  /** How many lanes its group of overlapping appointments needs. */
  lanes: number;
}

/**
 * Side-by-side lanes for overlapping appointments of one column, as most
 * calendars do: each takes the first lane free at its start, and every
 * appointment of a group that overlaps (directly or through another) shares
 * that group's lane count, so they split the column's width evenly. They used
 * to be drawn on top of each other, the later one hiding the earlier.
 */
export function layoutLanes(items: { id: string; start: number; end: number }[]): Map<string, Lane> {
  const sorted = [...items].sort((a, b) => a.start - b.start || b.end - a.end);
  const out = new Map<string, Lane>();
  let group: string[] = [];
  let laneEnds: number[] = [];
  let groupEnd = -Infinity;
  const closeGroup = () => {
    for (const id of group) out.get(id)!.lanes = laneEnds.length;
    group = [];
    laneEnds = [];
  };
  for (const item of sorted) {
    if (item.start >= groupEnd) closeGroup();
    let lane = laneEnds.findIndex((end) => end <= item.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(item.end);
    } else {
      laneEnds[lane] = item.end;
    }
    out.set(item.id, { lane, lanes: 1 });
    group.push(item.id);
    groupEnd = Math.max(groupEnd, item.end);
  }
  closeGroup();
  return out;
}

/**
 * The columns of the day: active professionals, plus an inactive one only
 * while they still have appointments that day (so none is hidden). Staff
 * receive every professional of the salon, the inactive ones too.
 */
export function visibleProfessionals<P extends { id: string; isActive?: boolean }>(
  professionals: P[],
  appointments: { professionalId: string }[],
): P[] {
  const booked = new Set(appointments.map((a) => a.professionalId));
  return professionals.filter((p) => p.isActive !== false || booked.has(p.id));
}

/**
 * Where the grid opens, in minutes since midnight: an hour before now on
 * today, half an hour before the first appointment on another day, the top
 * otherwise.
 */
export function initialScrollMinutes(input: {
  isToday: boolean;
  nowMinutes: number;
  firstAppointment?: number;
  startHour: number;
}): number {
  const top = input.startHour * 60;
  if (input.isToday) return Math.max(top, input.nowMinutes - 60);
  if (input.firstAppointment !== undefined) return Math.max(top, input.firstAppointment - 30);
  return top;
}
