/**
 * The salon's own opening hours (Tenant.openingHours): how the dashboard reads
 * them, edits them in settings and saves them.
 *
 * Stored in the same flat format as a professional's `workingHours`
 * (lib/weekly-schedule.ts): `[{ day: "monday", openTime, closeTime }, ...]`,
 * several entries for a day being shifts and a day without entries closed.
 * The same reading as the server's salonHoursEntries (backend
 * appointments/working-hours.ts), which decides availability:
 *
 *   - a list with entries: the salon's week;
 *   - the old settings pair `{ open, close }`: that window every day;
 *   - anything else (`{}`, `[]`, the old onboarding wizard's
 *     `{ mon: { open, close } }`): no salon-level hours -- each professional's
 *     own schedule decides, as before salon hours existed.
 *
 * No React and no Next imports, so lib/salon-hours.spec.ts can run them.
 */
import {
  WEEK_DAYS,
  defaultSchedule,
  scheduleFromWorkingHours,
  scheduleProblems,
  workingHoursFromSchedule,
  type DayKey,
  type WeeklySchedule,
  type WorkingHoursEntry,
} from "./weekly-schedule";

function minutesOf(time: unknown): number | null {
  if (typeof time !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(time.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function clock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

/** The old `{ open, close }` pair, when readable (open before close). */
function legacyPair(raw: unknown): { open: string; close: string } | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const { open, close } = raw as { open?: unknown; close?: unknown };
  const start = minutesOf(open);
  const end = minutesOf(close);
  if (start === null || end === null || end <= start) return null;
  return { open: clock(start), close: clock(end) };
}

function isEntry(e: unknown): e is { day: string; openTime: string; closeTime: string } {
  return (
    !!e &&
    typeof e === "object" &&
    typeof (e as WorkingHoursEntry).day === "string" &&
    typeof (e as WorkingHoursEntry).openTime === "string" &&
    typeof (e as WorkingHoursEntry).closeTime === "string"
  );
}

/** The salon's week in the list format, or undefined when it recorded none. */
export function salonHoursEntries(raw: unknown): WorkingHoursEntry[] | undefined {
  if (Array.isArray(raw)) {
    const entries = raw.filter(isEntry) as WorkingHoursEntry[];
    return entries.length > 0 ? entries : undefined;
  }
  const pair = legacyPair(raw);
  if (!pair) return undefined;
  return WEEK_DAYS.map(({ key }) => ({ day: key, openTime: pair.open, closeTime: pair.close }));
}

/** The old onboarding wizard's keys, Monday first. */
const WIZARD_KEYS: ReadonlyArray<[string, DayKey]> = [
  ["mon", "monday"],
  ["tue", "tuesday"],
  ["wed", "wednesday"],
  ["thu", "thursday"],
  ["fri", "friday"],
  ["sat", "saturday"],
  ["sun", "sunday"],
];

/**
 * What the settings page shows. `limited` is whether the salon has hours of
 * its own; `week` is what the editor holds -- the salon's week when it has
 * one, else a starting point to switch on: the week the old onboarding wizard
 * stored (never applied until saved here), or Monday to Friday 09:00–19:00.
 */
export interface SalonHoursSetting {
  limited: boolean;
  week: WeeklySchedule;
}

export function salonHoursSettingFrom(raw: unknown): SalonHoursSetting {
  const own = salonHoursEntries(raw);
  const week = own ? scheduleFromWorkingHours(own) : null;
  if (week) return { limited: true, week };

  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    const wizard: WorkingHoursEntry[] = [];
    for (const [key, day] of WIZARD_KEYS) {
      const v = (raw as Record<string, unknown>)[key] as { open?: unknown; close?: unknown } | null | undefined;
      if (v && typeof v.open === "string" && typeof v.close === "string") {
        wizard.push({ day, openTime: v.open, closeTime: v.close });
      }
    }
    const fromWizard = scheduleFromWorkingHours(wizard);
    if (fromWizard) return { limited: false, week: fromWizard };
  }
  return { limited: false, week: defaultSchedule() };
}

/** The PATCH /auth/tenant `openingHours`: the week, or [] for no salon-level hours. */
export function openingHoursForSave(setting: SalonHoursSetting): WorkingHoursEntry[] {
  return setting.limited ? workingHoursFromSchedule(setting.week) : [];
}

/** Whether two settings would save the same value. */
export function sameSalonHours(a: SalonHoursSetting | undefined, b: SalonHoursSetting | undefined): boolean {
  if (!a || !b) return a === b;
  return JSON.stringify(openingHoursForSave(a)) === JSON.stringify(openingHoursForSave(b));
}

export const SALON_WEEK_EMPTY =
  "Marca al menos un día de apertura. Si el salón no quiere un horario propio, elige «Sin horario del salón».";

/**
 * Why the salon's hours cannot be saved, or null. Nothing to check when it
 * has none. A week with every day closed is refused: stored, it would read
 * as "no salon-level hours" -- the opposite of closing every day.
 */
export function salonHoursProblem(setting: SalonHoursSetting): string | null {
  if (!setting.limited) return null;
  const problems = scheduleProblems(setting.week);
  const day = WEEK_DAYS.find(({ key }) => problems.days[key]);
  if (day) return `${day.label}: ${problems.days[day.key]}`;
  return problems.week ? SALON_WEEK_EMPTY : null;
}

/**
 * The salon's open stretches on a weekday ("monday"...), in minutes, merged:
 * undefined when it recorded no hours, [] when it is closed that day.
 */
export function salonWindowsOn(
  raw: unknown,
  weekday: string,
): Array<{ start: number; end: number }> | undefined {
  const entries = salonHoursEntries(raw);
  if (!entries) return undefined;
  const windows: Array<{ start: number; end: number }> = [];
  for (const e of entries) {
    if (e.day.toLowerCase() !== weekday) continue;
    const start = minutesOf(e.openTime);
    const end = minutesOf(e.closeTime);
    if (start !== null && end !== null && end > start) windows.push({ start, end });
  }
  windows.sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Array<{ start: number; end: number }> = [];
  for (const w of windows) {
    const last = merged[merged.length - 1];
    if (last && w.start <= last.end) last.end = Math.max(last.end, w.end);
    else merged.push({ ...w });
  }
  return merged;
}
