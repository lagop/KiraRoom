import {
  ShiftWindow,
  clockOf,
  minutesOf,
  subtractWindows,
} from "../appointments/working-hours";

/**
 * Time off and salon closures, as every check that books a slot reads them:
 * availability (getAvailableSlots), the booking and move checks
 * (reschedule-check.ts), the conflict preview, the calendar and the
 * receptionist. Pure, so the rules are tested once (time-off-rules.spec.ts).
 *
 * A block is a range of the salon's calendar days ("YYYY-MM-DD", inclusive),
 * all day or -- on one single day only -- a stretch of hours on the salon's
 * clock: the same reading as an appointment's scheduledDate + scheduledTime,
 * with no timezone math. A block with no professional closes the salon for
 * everyone.
 */

export type TimeOffKindName = "vacation" | "day_off" | "sick_leave" | "closure" | "other";

export const TIME_OFF_KINDS: readonly TimeOffKindName[] = [
  "vacation",
  "day_off",
  "sick_leave",
  "closure",
  "other",
];

export type TimeOffStatusName = "approved" | "pending" | "rejected";

export const TIME_OFF_STATUSES: readonly TimeOffStatusName[] = ["approved", "pending", "rejected"];

/**
 * What a professional may ask for themselves (POST /time-off/requests). Not
 * a closure (the salon's), and not sick leave: a baja is not something the
 * salon approves -- the professional tells whoever runs the salon, who
 * records it (and keeps it from the rest of the team, GDPR art. 9).
 */
export const REQUESTABLE_KINDS: readonly TimeOffKindName[] = ["vacation", "day_off", "other"];

export interface TimeOffBlock {
  id?: string;
  /** Absent: approved (a block read before requests existed). */
  status?: TimeOffStatusName | string | null;
  /** Null: the whole salon is closed. */
  professionalId: string | null;
  kind: TimeOffKindName | string;
  startDate: Date | string;
  endDate: Date | string;
  startTime?: string | null;
  endTime?: string | null;
  note?: string | null;
}

/**
 * Only approved time off blocks anything: a request still pending, or one
 * rejected, leaves the agenda as it was. Queries ask for approved rows
 * (timeOffBetween); this keeps a row that slipped through from blocking.
 */
export function blocksAgenda(block: Pick<TimeOffBlock, "status">): boolean {
  return block.status == null || block.status === "approved";
}

/** The whole of a salon day, for professionals with no schedule recorded. */
export const WHOLE_DAY: ShiftWindow = { startMinutes: 0, endMinutes: 24 * 60 };

/** One block may span at most this many days (a year, leap day included). */
export const MAX_SPAN_DAYS = 366;
/** GET /time-off may ask for at most this many days at once. */
export const MAX_QUERY_DAYS = 400;

export const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** "YYYY-MM-DD" of a stored date (a Postgres DATE arrives as UTC midnight). */
export function dayOf(value: Date | string): string {
  return typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);
}

/** UTC midnight of a "YYYY-MM-DD" day, for queries on DATE columns; null when not a real day. */
export function dateOfDay(day: string): Date | null {
  if (!DATE_PATTERN.test(day)) return null;
  const date = new Date(`${day}T00:00:00.000Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day ? null : date;
}

/** Days from `from` to `to`, both counted ("2026-12-24" to "2026-12-25" is 2). */
export function daysInRange(from: string, to: string): number {
  const a = dateOfDay(from);
  const b = dateOfDay(to);
  if (!a || !b) return NaN;
  return Math.round((b.getTime() - a.getTime()) / 86_400_000) + 1;
}

export function isAllDay(block: Pick<TimeOffBlock, "startTime" | "endTime">): boolean {
  return !block.startTime || !block.endTime;
}

export function coversDay(block: TimeOffBlock, day: string): boolean {
  return dayOf(block.startDate) <= day && day <= dayOf(block.endDate);
}

/** The minutes a block takes out of each day it covers. */
export function blockWindow(block: TimeOffBlock): ShiftWindow {
  if (isAllDay(block)) return { ...WHOLE_DAY };
  const start = minutesOf(block.startTime as string);
  const end = minutesOf(block.endTime as string);
  // An unreadable time is read as the whole day: never a licence to book.
  if (start === null || end === null || end <= start) return { ...WHOLE_DAY };
  return { startMinutes: start, endMinutes: end };
}

/** What is blocked on one day for one professional (or, for null, the salon). */
export interface DayBlocks {
  /** A block that takes the whole day, the salon's first. */
  allDay: TimeOffBlock | null;
  /** The partial blocks' minutes. */
  windows: ShiftWindow[];
  /** Every block that applies, the salon's first. */
  blocks: TimeOffBlock[];
}

/**
 * The blocks that apply to `professionalId` on `day`: the salon's closures
 * and the professional's own time off. With `professionalId` null, only the
 * salon's.
 */
export function dayBlocks(
  blocks: ReadonlyArray<TimeOffBlock>,
  day: string,
  professionalId: string | null,
): DayBlocks {
  const applying = blocks
    .filter(blocksAgenda)
    .filter((b) => coversDay(b, day))
    .filter((b) => b.professionalId === null || (professionalId !== null && b.professionalId === professionalId))
    .sort((a, b) => Number(a.professionalId !== null) - Number(b.professionalId !== null));
  return {
    allDay: applying.find((b) => isAllDay(b)) ?? null,
    windows: applying.filter((b) => !isAllDay(b)).map(blockWindow),
    blocks: applying,
  };
}

/**
 * A professional's working windows on a day once its blocks are taken out,
 * in workingWindowsFor's terms: undefined = no schedule and nothing blocked
 * (no limit), [] = not available at all, else the windows left.
 *
 * With no schedule recorded a partial block still blocks its minutes: the
 * rest of the day stays unlimited (WHOLE_DAY minus the block).
 */
export function availableWindows(
  shifts: ShiftWindow[] | undefined,
  blocked: DayBlocks,
): ShiftWindow[] | undefined {
  if (blocked.allDay) return [];
  if (blocked.windows.length === 0) return shifts;
  return subtractWindows(shifts ?? [WHOLE_DAY], blocked.windows);
}

/** The salon's all-day closure on `day`, if any. */
export function salonClosedOn(blocks: ReadonlyArray<TimeOffBlock>, day: string): TimeOffBlock | null {
  return dayBlocks(blocks, day, null).allDay;
}

const ALL_DAY_REASON: Record<string, (name: string) => string> = {
  vacation: (name) => `${name} está de vacaciones ese día.`,
  day_off: (name) => `${name} libra ese día.`,
};

const noteOf = (block: TimeOffBlock) => (block.note?.trim() ? ` (${block.note.trim()})` : "");

/**
 * Why `block` stops a booking, in the words the salon reads. A closure names
 * its note ("Navidad"): it is the salon's. A professional's note is never in
 * it -- a professional booking a colleague reads this too, and the reason for
 * someone's absence is not theirs to read. Sick leave reads like any other
 * absence for the same reason: that a colleague is ill is health data.
 */
export function timeOffReason(block: TimeOffBlock, professionalName: string): string {
  const window = blockWindow(block);
  const hours = `de ${clockOf(window.startMinutes)} a ${clockOf(window.endMinutes)}`;
  if (block.professionalId === null) {
    return isAllDay(block)
      ? `El salón está cerrado ese día${noteOf(block)}.`
      : `El salón está cerrado ${hours} ese día${noteOf(block)}.`;
  }
  if (!isAllDay(block)) return `${professionalName} no está disponible ${hours} ese día.`;
  return (ALL_DAY_REASON[block.kind] ?? ((name: string) => `${name} no está disponible ese día.`))(
    professionalName,
  );
}

/**
 * The reason a service from `startMinutes` for `durationMinutes` cannot be
 * booked for the professional on `day` because of time off or a closure;
 * null when nothing blocks it.
 */
export function timeOffProblem(input: {
  blocks: ReadonlyArray<TimeOffBlock>;
  day: string;
  professionalId: string;
  professionalName: string;
  startMinutes: number;
  durationMinutes: number;
}): string | null {
  const { blocks } = dayBlocks(input.blocks, input.day, input.professionalId);
  const end = input.startMinutes + Math.max(input.durationMinutes, 1);
  const hit = blocks.find((b) => {
    const w = blockWindow(b);
    return w.startMinutes < end && input.startMinutes < w.endMinutes;
  });
  return hit ? timeOffReason(hit, input.professionalName) : null;
}

/** What a create or an edit may store, before it reaches the database. */
export interface TimeOffInput {
  professionalId?: string | null;
  kind: string;
  startDate: string;
  endDate: string;
  startTime?: string | null;
  endTime?: string | null;
  note?: string | null;
}

/**
 * Why a block cannot be stored, in Spanish; null when it can. The DTO runs it
 * on a create and the service on the merged row of an edit; the table's CHECK
 * constraints say the same.
 */
export function timeOffInputProblem(input: TimeOffInput): string | null {
  if (!TIME_OFF_KINDS.includes(input.kind as TimeOffKindName)) return "El tipo de ausencia no es válido.";
  const salonWide = !input.professionalId;
  if (salonWide && input.kind !== "closure") return "Elige un profesional, o registra un cierre del salón.";
  if (!salonWide && input.kind === "closure") return "Un cierre es de todo el salón: no lleva profesional.";

  if (!dateOfDay(input.startDate ?? "") || !dateOfDay(input.endDate ?? "")) {
    return "Las fechas tienen que ser días válidos (AAAA-MM-DD).";
  }
  if (input.endDate < input.startDate) return "La fecha de fin no puede ser anterior a la de inicio.";
  if (daysInRange(input.startDate, input.endDate) > MAX_SPAN_DAYS) {
    return `Una ausencia puede durar como máximo ${MAX_SPAN_DAYS} días.`;
  }

  const hasStart = !!input.startTime;
  const hasEnd = !!input.endTime;
  if (hasStart !== hasEnd) return "Indica la hora de inicio y la de fin, o marca todo el día.";
  if (hasStart && hasEnd) {
    if (!TIME_PATTERN.test(input.startTime as string) || !TIME_PATTERN.test(input.endTime as string)) {
      return "Las horas tienen que ser HH:MM.";
    }
    if (input.startDate !== input.endDate) return "Las horas solo se pueden indicar para un único día.";
    if ((input.endTime as string) <= (input.startTime as string)) {
      return "La hora de fin tiene que ser posterior a la de inicio.";
    }
  }
  if (input.note != null && String(input.note).length > 200) return "La nota puede tener como máximo 200 caracteres.";
  return null;
}

/** The salon days a block covers, in order, `limit` at most. */
export function daysOf(block: TimeOffBlock, limit = MAX_SPAN_DAYS + 1): string[] {
  const out: string[] = [];
  const start = dateOfDay(dayOf(block.startDate));
  const end = dayOf(block.endDate);
  if (!start) return out;
  for (let t = start.getTime(); out.length < limit; t += 86_400_000) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (day > end) break;
    out.push(day);
  }
  return out;
}

const REQUEST_KIND_WORDS: Record<string, string> = {
  vacation: "vacaciones",
  day_off: "un día libre",
  sick_leave: "una ausencia",
  other: "una ausencia",
};

/** "24/12/2026" for a "YYYY-MM-DD" day. */
function spanishDay(value: Date | string): string {
  const [y, m, d] = dayOf(value).split("-");
  return `${d}/${m}/${y}`;
}

/**
 * The days and hours of a block as a sentence ends: "el 24/12/2026",
 * "del 24/12/2026 al 26/12/2026", "el 24/12/2026 de 10:00 a 12:00".
 */
export function periodLabel(block: TimeOffBlock): string {
  const start = dayOf(block.startDate);
  const end = dayOf(block.endDate);
  if (start !== end) return `del ${spanishDay(start)} al ${spanishDay(end)}`;
  const hours = isAllDay(block) ? "" : ` de ${block.startTime} a ${block.endTime}`;
  return `el ${spanishDay(start)}${hours}`;
}

/** "vacaciones el 24/12/2026", for the notifications about a request. */
export function requestSummary(block: TimeOffBlock): string {
  return `${REQUEST_KIND_WORDS[block.kind] ?? "una ausencia"} ${periodLabel(block)}`;
}
