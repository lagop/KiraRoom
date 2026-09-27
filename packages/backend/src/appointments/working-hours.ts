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
