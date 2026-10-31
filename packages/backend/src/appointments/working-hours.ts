/**
 * A professional's working hours, as the onboarding wizard stores them.
 *
 * `getAvailableSlots` did not consult these at all. It built the day's slots
 * from the tenant's `openingHours` — read as a single `{ open, close }` pair
 * for the whole week — and then only checked for clashes with existing
 * appointments.
 *
 * So a salon whose only professional works Monday to Friday, 09:00 to 18:00,
 * was offered slots on Sunday and at 19:30, because nothing in the chain knew
 * when she actually works. The onboarding writes the hours per weekday onto
 * the professional (`professionals.workingHours`) and leaves the tenant's
 * `openingHours` as `{}`, so the one place the hours exist was the one place
 * availability never looked.
 *
 * A weekday may have several entries: each is a shift of its own (jornada
 * partida, 10:00–14:00 and 17:00–20:00, is two entries with `day: "monday"`).
 */

export interface WorkingHoursEntry {
  day: string;
  openTime: string;
  closeTime: string;
}

/** Index 0 is Sunday, matching `Date.prototype.getUTCDay`. */
const WEEKDAY_NAMES = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

export function weekdayNameOf(date: Date): string {
  return WEEKDAY_NAMES[date.getUTCDay()];
}

/** Minutes since midnight for "HH:MM". Returns null when unparseable. */
export function minutesOf(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** "HH:MM" for minutes since midnight. */
export function clockOf(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

export function parseWorkingHours(raw: unknown): WorkingHoursEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is WorkingHoursEntry =>
      !!e &&
      typeof e === "object" &&
      typeof (e as WorkingHoursEntry).day === "string" &&
      typeof (e as WorkingHoursEntry).openTime === "string" &&
      typeof (e as WorkingHoursEntry).closeTime === "string",
  );
}

/** A stretch of a day someone works, in minutes since midnight. */
export interface ShiftWindow {
  startMinutes: number;
  endMinutes: number;
}

/**
 * Sorted by start, with overlapping or touching windows joined into one.
 *
 * Joined because a 10:00–14:00 shift followed by a 14:00–18:00 one is, for
 * anyone booking, a day from 10:00 to 18:00: a service from 13:30 to 14:30 is
 * fine. The input validation refuses overlaps, but rows written before it are
 * read here too, and a union is the only reading that never offers a minute
 * outside every shift.
 *
 * Windows in, windows out, so that blocked intervals (time off, salon
 * closures) can later be taken out of the result the same way.
 */
export function mergeWindows(windows: ReadonlyArray<ShiftWindow>): ShiftWindow[] {
  const sorted = [...windows].sort(
    (a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes,
  );
  const out: ShiftWindow[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.startMinutes <= last.endMinutes) {
      last.endMinutes = Math.max(last.endMinutes, w.endMinutes);
    } else {
      out.push({ startMinutes: w.startMinutes, endMinutes: w.endMinutes });
    }
  }
  return out;
}

/** The valid shifts among `entries` on weekday `day` ("monday"...), merged. */
function shiftsOnDay(entries: ReadonlyArray<WorkingHoursEntry>, day: string): ShiftWindow[] {
  const windows: ShiftWindow[] = [];
  for (const entry of entries) {
    if (entry.day.toLowerCase() !== day) continue;
    const startMinutes = minutesOf(entry.openTime);
    const endMinutes = minutesOf(entry.closeTime);
    // A malformed entry is not a licence to book at any hour: it is skipped,
    // and a day with nothing else on it is a day off.
    if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) continue;
    windows.push({ startMinutes, endMinutes });
  }
  return mergeWindows(windows);
}

/**
 * The shifts a professional works on `date`, sorted by start.
 *
 * This replaced a single-window version that used `entries.find`: with a split
 * day only the first entry was read, so the afternoon shift did not exist for
 * availability, the reschedule check, occupancy or the receptionist.
 *
 * An empty or unparseable `workingHours` returns `undefined`, meaning "no
 * schedule recorded". Callers treat that as "no constraint" rather than "never
 * available": a professional whose hours were never filled in must stay
 * bookable, or filling this gap would make every existing salon unbookable.
 *
 * The three cases are deliberately distinct:
 *   undefined — nothing recorded, impose no limit
 *   []        — has a schedule, and does not work this day
 *   windows   — works these minutes; the gaps between them are not working
 */
export function workingWindowsFor(
  workingHours: unknown,
  date: Date,
): ShiftWindow[] | undefined {
  const entries = parseWorkingHours(workingHours);
  if (entries.length === 0) return undefined;
  return shiftsOnDay(entries, weekdayNameOf(date));
}

/**
 * True when a service of `durationMinutes` starting at `slotMinutes` fits
 * entirely inside the window. A slot that starts before closing but runs past
 * it is not bookable: the appointment would outlast the shift.
 */
export function fitsInWindow(
  slotMinutes: number,
  durationMinutes: number,
  window: ShiftWindow,
): boolean {
  return (
    slotMinutes >= window.startMinutes &&
    slotMinutes + durationMinutes <= window.endMinutes
  );
}

/**
 * True when the service fits entirely inside ONE of the shifts. Starting in
 * the morning shift and running into the lunch gap is not bookable, even if
 * the afternoon shift would cover the rest: nobody is there in between.
 */
export function fitsInShifts(
  slotMinutes: number,
  durationMinutes: number,
  windows: ReadonlyArray<ShiftWindow>,
): boolean {
  return windows.some((w) => fitsInWindow(slotMinutes, durationMinutes, w));
}

/** "10:00–14:00 y 17:00–20:00": shifts the way a salon says them. */
export function describeShifts(
  windows: ReadonlyArray<ShiftWindow>,
  joiner = " y ",
): string {
  return windows
    .map((w) => `${clockOf(w.startMinutes)}–${clockOf(w.endMinutes)}`)
    .join(joiner);
}

/** A salon's open window on one weekday. */
export interface SalonDayWindow {
  openTime: string;
  closeTime: string;
}

/**
 * The salon's open stretches for a week, derived from its professionals'
 * schedules: per weekday, the union of everyone's shifts.
 *
 * A client asking "when are you open?" means the salon, not one stylist, so a
 * stretch is open while ANY professional is in. A salon where everyone stops
 * from 14:00 to 17:00 is closed then and says so (two stretches); if one
 * stylist covers lunch, the union has no gap and it is one stretch. Days
 * nobody works are absent from the result, which the caller renders as
 * closed.
 *
 * Returns `{}` when no professional has a schedule recorded, so the caller can
 * say the hours are unknown rather than invent them.
 */
export function salonShiftsFrom(
  professionals: ReadonlyArray<{ workingHours?: unknown }>,
): Record<string, SalonDayWindow[]> {
  const byDay = new Map<string, ShiftWindow[]>();
  for (const professional of professionals) {
    const entries = parseWorkingHours(professional.workingHours);
    if (entries.length === 0) continue;
    for (const day of WEEKDAY_NAMES) {
      const shifts = shiftsOnDay(entries, day);
      if (shifts.length > 0) byDay.set(day, [...(byDay.get(day) ?? []), ...shifts]);
    }
  }

  const week: Record<string, SalonDayWindow[]> = {};
  for (const day of WEEKDAY_NAMES) {
    const windows = byDay.get(day);
    if (!windows) continue;
    week[day] = mergeWindows(windows).map((w) => ({
      openTime: clockOf(w.startMinutes),
      closeTime: clockOf(w.endMinutes),
    }));
  }
  return week;
}

/**
 * The salon's opening hours for a week as ONE window per day: from the
 * earliest any professional starts to the latest any of them finishes. The
 * public page's `openingHours` keeps this shape for clients that predate split
 * shifts; `salonShiftsFrom` is the same week with its gaps.
 *
 * This exists because the receptionist's prompt used to carry a hardcoded
 * Monday-to-Friday 09:00-18:00 plus Saturday 09:00-14:00 for every salon,
 * contradicting the very schedules `check_availability` reads. The model was
 * handed one version of reality and its tools another.
 *
 * Returns `{}` when no professional has a schedule recorded, so the caller can
 * say the hours are unknown rather than invent them.
 */
export function salonWeekFrom(
  professionals: ReadonlyArray<{ workingHours?: unknown }>,
): Record<string, SalonDayWindow> {
  const week: Record<string, SalonDayWindow> = {};
  for (const [day, stretches] of Object.entries(salonShiftsFrom(professionals))) {
    week[day] = {
      openTime: stretches[0].openTime,
      closeTime: stretches[stretches.length - 1].closeTime,
    };
  }
  return week;
}
