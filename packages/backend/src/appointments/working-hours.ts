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

/**
 * The window a professional works on `date`, or `null` when they do not work
 * that day.
 *
 * An empty or unparseable `workingHours` returns `undefined`, meaning "no
 * schedule recorded". Callers treat that as "no constraint" rather than "never
 * available": a professional whose hours were never filled in must stay
 * bookable, or filling this gap would make every existing salon unbookable.
 *
 * The three cases are deliberately distinct:
 *   undefined — nothing recorded, impose no limit
 *   null      — has a schedule, and does not work this day
 *   window    — works these minutes
 */
export function workingWindowFor(
  workingHours: unknown,
  date: Date,
): { startMinutes: number; endMinutes: number } | null | undefined {
  const entries = parseWorkingHours(workingHours);
  if (entries.length === 0) return undefined;

  const wanted = weekdayNameOf(date);
  const entry = entries.find((e) => e.day.toLowerCase() === wanted);
  if (!entry) return null;

  const startMinutes = minutesOf(entry.openTime);
  const endMinutes = minutesOf(entry.closeTime);
  if (startMinutes === null || endMinutes === null || endMinutes <= startMinutes) {
    // A malformed entry is not a licence to book at any hour.
    return null;
  }

  return { startMinutes, endMinutes };
}

/**
 * True when a service of `durationMinutes` starting at `slotMinutes` fits
 * entirely inside the window. A slot that starts before closing but runs past
 * it is not bookable: the appointment would outlast the shift.
 */
export function fitsInWindow(
  slotMinutes: number,
  durationMinutes: number,
  window: { startMinutes: number; endMinutes: number },
): boolean {
  return (
    slotMinutes >= window.startMinutes &&
    slotMinutes + durationMinutes <= window.endMinutes
  );
}

/** A salon's open window on one weekday. */
export interface SalonDayWindow {
  openTime: string;
  closeTime: string;
}

/**
 * The salon's opening hours for a week, derived from its professionals'
 * schedules.
 *
 * A client asking "when are you open?" means the salon, not one stylist, so a
 * weekday runs from the earliest any professional starts to the latest any of
 * them finishes. Days nobody works are absent from the result, which the
 * caller renders as closed.
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

  for (const professional of professionals) {
    for (const entry of parseWorkingHours(professional.workingHours)) {
      const day = entry.day.toLowerCase();
      if (!WEEKDAY_NAMES.includes(day)) continue;

      const open = minutesOf(entry.openTime);
      const close = minutesOf(entry.closeTime);
      if (open === null || close === null || close <= open) continue;

      const current = week[day];
      if (!current) {
        week[day] = { openTime: entry.openTime, closeTime: entry.closeTime };
        continue;
      }
      // Widen the window: earliest open, latest close.
      if (open < (minutesOf(current.openTime) ?? Infinity)) {
        current.openTime = entry.openTime;
      }
      if (close > (minutesOf(current.closeTime) ?? -Infinity)) {
        current.closeTime = entry.closeTime;
      }
    }
  }

  return week;
}
