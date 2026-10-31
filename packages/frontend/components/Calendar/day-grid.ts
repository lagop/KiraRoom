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
