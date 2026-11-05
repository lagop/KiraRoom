/**
 * A professional's week as the schedule editor works on it, and its
 * conversion to and from what the API stores.
 *
 * The API stores `workingHours` as a flat list, one entry per shift:
 * `[{ day: "monday", openTime: "10:00", closeTime: "14:00" }, ...]`. A split
 * day (jornada partida) is two entries for the same weekday. Nothing in the
 * dashboard edited this after the onboarding wizard wrote it, and the wizard
 * only knew one window per day.
 *
 * The rules mirror the server's (backend professionals/working-hours-input.ts):
 * HH:MM times, the end after the start, no overlapping shifts in a day, at
 * most 21 shifts. Checking here as well lets the salon see the problem next
 * to the day it is on, instead of a 400 after pressing save.
 *
 * No React and no Next imports, so lib/weekly-schedule.spec.ts can run them.
 */

export type DayKey =
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday";

/** Monday first: how a salon reads its own week. */
export const WEEK_DAYS: ReadonlyArray<{ key: DayKey; label: string }> = [
  { key: "monday", label: "Lunes" },
  { key: "tuesday", label: "Martes" },
  { key: "wednesday", label: "Miércoles" },
  { key: "thursday", label: "Jueves" },
  { key: "friday", label: "Viernes" },
  { key: "saturday", label: "Sábado" },
  { key: "sunday", label: "Domingo" },
];

const WEEKDAYS: ReadonlyArray<DayKey> = ["tuesday", "wednesday", "thursday", "friday"];

/** Three a day is what the server allows across the week (21). */
export const MAX_SHIFTS_PER_DAY = 3;

export interface Shift {
  /** "HH:MM", as an <input type="time"> gives it ("" while empty). */
  start: string;
  end: string;
}

export interface DaySchedule {
  works: boolean;
  shifts: Shift[];
}

export type WeeklySchedule = Record<DayKey, DaySchedule>;

/** A workingHours entry as the API takes and returns it. */
export interface WorkingHoursEntry {
  day: DayKey;
  openTime: string;
  closeTime: string;
}

/** The shift a day gets when it is switched on. The onboarding's default. */
export const DEFAULT_SHIFT: Shift = { start: "09:00", end: "19:00" };

/** Monday to Friday, 09:00 to 19:00: what the onboarding wizard proposes. */
export function defaultSchedule(): WeeklySchedule {
  const week = {} as WeeklySchedule;
  for (const { key } of WEEK_DAYS) {
    const works = key !== "saturday" && key !== "sunday";
    week[key] = { works, shifts: works ? [{ ...DEFAULT_SHIFT }] : [] };
  }
  return week;
}

/** Minutes since midnight for "HH:MM", or null. */
export function minutesOf(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec((time ?? "").trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function pad(time: string): string {
  const m = minutesOf(time);
  if (m === null) return time;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

function byStart(a: Shift, b: Shift): number {
  return (minutesOf(a.start) ?? 0) - (minutesOf(b.start) ?? 0);
}

/**
 * The editor's week for a stored `workingHours`, or null when no schedule is
 * recorded (not a list, or no entry shaped like a shift). Null is not "never
 * works": online booking puts no limit on such a professional, and the editor
 * says so instead of showing a made-up week that saving would impose.
 *
 * Entries the server would skip (an unknown day, an unreadable time, an end
 * before its start) are left out, so what the salon sees is what is used.
 */
export function scheduleFromWorkingHours(raw: unknown): WeeklySchedule | null {
  if (!Array.isArray(raw)) return null;
  const entries = raw.filter(
    (e): e is { day: string; openTime: string; closeTime: string } =>
      !!e &&
      typeof e === "object" &&
      typeof e.day === "string" &&
      typeof e.openTime === "string" &&
      typeof e.closeTime === "string",
  );
  if (entries.length === 0) return null;

  const week = {} as WeeklySchedule;
  for (const { key } of WEEK_DAYS) week[key] = { works: false, shifts: [] };
  for (const e of entries) {
    const day = e.day.trim().toLowerCase() as DayKey;
    if (!week[day]) continue;
    const start = minutesOf(e.openTime);
    const end = minutesOf(e.closeTime);
    if (start === null || end === null || end <= start) continue;
    week[day].shifts.push({ start: pad(e.openTime), end: pad(e.closeTime) });
  }
  for (const { key } of WEEK_DAYS) {
    week[key].shifts.sort(byStart);
    week[key].works = week[key].shifts.length > 0;
  }
  return week;
}

/** What the API stores: working days only, Monday first, shifts by start. */
export function workingHoursFromSchedule(week: WeeklySchedule): WorkingHoursEntry[] {
  const out: WorkingHoursEntry[] = [];
  for (const { key } of WEEK_DAYS) {
    const day = week[key];
    if (!day?.works) continue;
    for (const s of [...day.shifts].sort(byStart)) {
      out.push({ day: key, openTime: pad(s.start), closeTime: pad(s.end) });
    }
  }
  return out;
}

/** Why a working day cannot be saved, or null. */
export function dayProblem(day: DaySchedule): string | null {
  if (!day.works) return null;
  if (day.shifts.length === 0) return "Añade al menos un tramo o marca el día como libre.";
  if (day.shifts.length > MAX_SHIFTS_PER_DAY) {
    return `Como máximo ${MAX_SHIFTS_PER_DAY} tramos por día.`;
  }
  const read: Array<{ start: number; end: number; label: string }> = [];
  for (const s of day.shifts) {
    const start = minutesOf(s.start);
    const end = minutesOf(s.end);
    if (start === null || end === null) return "Indica la hora de inicio y la de fin de cada tramo.";
    if (end <= start) return `El tramo que empieza a las ${pad(s.start)} termina antes de empezar.`;
    read.push({ start, end, label: `${pad(s.start)}–${pad(s.end)}` });
  }
  read.sort((a, b) => a.start - b.start);
  for (let i = 1; i < read.length; i++) {
    // Touching is fine (10:00–14:00 then 14:00–18:00); overlapping is not.
    if (read[i].start < read[i - 1].end) {
      return `Los tramos ${read[i - 1].label} y ${read[i].label} se solapan.`;
    }
  }
  return null;
}

/**
 * Every problem of the week: per day, and one for the week as a whole. A week
 * with no working day is refused because the API would store an empty list,
 * which reads as "no schedule recorded" -- bookable at any hour, the opposite
 * of what unticking every day means. A professional who no longer works is
 * made inactive instead.
 */
export function scheduleProblems(week: WeeklySchedule): {
  days: Partial<Record<DayKey, string>>;
  week: string | null;
} {
  const days: Partial<Record<DayKey, string>> = {};
  for (const { key } of WEEK_DAYS) {
    const problem = dayProblem(week[key]);
    if (problem) days[key] = problem;
  }
  const working = WEEK_DAYS.some(({ key }) => week[key].works);
  return {
    days,
    week: working ? null : "Marca al menos un día de trabajo. Si ya no trabaja aquí, desactiva al profesional.",
  };
}

export function hasProblems(week: WeeklySchedule): boolean {
  const p = scheduleProblems(week);
  return p.week !== null || Object.keys(p.days).length > 0;
}

/** Monday's day (on or off, and its shifts) copied onto Tuesday to Friday. */
export function copyMondayToWeekdays(week: WeeklySchedule): WeeklySchedule {
  const monday = week.monday;
  const next = { ...week };
  for (const key of WEEKDAYS) {
    next[key] = { works: monday.works, shifts: monday.shifts.map((s) => ({ ...s })) };
  }
  return next;
}

/** `day` switched on or off. On with no shifts yet gets the default shift. */
export function toggleDay(week: WeeklySchedule, day: DayKey): WeeklySchedule {
  const current = week[day];
  const works = !current.works;
  const shifts = works && current.shifts.length === 0 ? [{ ...DEFAULT_SHIFT }] : current.shifts;
  return { ...week, [day]: { works, shifts } };
}

/**
 * A new shift for `day`, after its last one: an hour after it ends, for two
 * hours, when that still fits in the day. The salon adjusts it.
 */
export function addShift(week: WeeklySchedule, day: DayKey): WeeklySchedule {
  const current = week[day];
  if (current.shifts.length >= MAX_SHIFTS_PER_DAY) return week;
  const lastEnd = Math.max(0, ...current.shifts.map((s) => minutesOf(s.end) ?? 0));
  const start = Math.min(lastEnd + 60, 21 * 60);
  const end = Math.min(start + 120, 23 * 60 + 59);
  const clock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
  const shift = current.shifts.length === 0 ? { ...DEFAULT_SHIFT } : { start: clock(start), end: clock(end) };
  return { ...week, [day]: { works: true, shifts: [...current.shifts, shift] } };
}

export function removeShift(week: WeeklySchedule, day: DayKey, index: number): WeeklySchedule {
  const shifts = week[day].shifts.filter((_, i) => i !== index);
  return { ...week, [day]: { works: shifts.length > 0 ? week[day].works : false, shifts } };
}

export function updateShift(
  week: WeeklySchedule,
  day: DayKey,
  index: number,
  patch: Partial<Shift>,
): WeeklySchedule {
  const shifts = week[day].shifts.map((s, i) => (i === index ? { ...s, ...patch } : s));
  return { ...week, [day]: { ...week[day], shifts } };
}
