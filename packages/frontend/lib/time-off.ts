/**
 * Time off and salon closures in the panel: the labels, how a block reads,
 * the form's checks and the clash message. Pure, tested in time-off.spec.ts.
 *
 * Dates are the salon's calendar days ("YYYY-MM-DD") and times its clock
 * ("HH:MM"), as the server stores them (time-off-rules.ts there): nothing
 * here goes through a Date's time zone.
 */

export type TimeOffKind = "vacation" | "day_off" | "sick_leave" | "closure" | "other";

export interface TimeOff {
  id: string;
  /** Null: the whole salon is closed. */
  professionalId: string | null;
  professionalName?: string | null;
  kind: TimeOffKind;
  startDate: string;
  endDate: string;
  startTime: string | null;
  endTime: string | null;
  /** Absent for staff on a colleague's absence. */
  note?: string | null;
}

export interface TimeOffInput {
  professionalId?: string | null;
  kind: TimeOffKind;
  startDate: string;
  endDate: string;
  startTime?: string | null;
  endTime?: string | null;
  note?: string | null;
}

export interface TimeOffConflict {
  id: string;
  date: string;
  time: string;
  clientName: string;
  serviceNames: string[];
  professionalName: string;
  status: string;
}

export const TIME_OFF_KIND_LABELS: Record<TimeOffKind, string> = {
  vacation: "Vacaciones",
  day_off: "Día libre",
  sick_leave: "Baja",
  closure: "Cierre",
  other: "Ausencia",
};

/** The kinds a professional's absence may be (a closure is the salon's). */
export const PERSONAL_KINDS: TimeOffKind[] = ["vacation", "day_off", "sick_leave", "other"];

export const MAX_SPAN_DAYS = 366;

const MONTHS = ["ene", "feb", "mar", "abr", "may", "jun", "jul", "ago", "sept", "oct", "nov", "dic"];

function parts(day: string): [number, number, number] {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  return [y, m, d];
}

/** "24 dic 2026" for a "YYYY-MM-DD" day. */
export function shortDay(day: string, withYear = true): string {
  const [y, m, d] = parts(day);
  return withYear ? `${d} ${MONTHS[m - 1]} ${y}` : `${d} ${MONTHS[m - 1]}`;
}

/** Days from `from` to `to`, both counted. */
export function daysInRange(from: string, to: string): number {
  const [y1, m1, d1] = parts(from);
  const [y2, m2, d2] = parts(to);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86_400_000) + 1;
}

/** `day` moved by `delta` calendar days ("YYYY-MM-DD"). */
export function addDays(day: string, delta: number): string {
  const [y, m, d] = parts(day);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** "24 dic 2026", "24–26 dic 2026", "30 dic 2026 – 2 ene 2027". */
export function dateRangeLabel(startDate: string, endDate: string): string {
  if (startDate === endDate) return shortDay(startDate);
  const [y1, m1] = parts(startDate);
  const [y2, m2, d2] = parts(endDate);
  if (y1 === y2 && m1 === m2) return `${parts(startDate)[2]}–${d2} ${MONTHS[m2 - 1]} ${y2}`;
  if (y1 === y2) return `${shortDay(startDate, false)} – ${shortDay(endDate)}`;
  return `${shortDay(startDate)} – ${shortDay(endDate)}`;
}

/** "Todo el día" or "10:00–12:00". */
export function hoursLabel(block: Pick<TimeOff, "startTime" | "endTime">): string {
  return block.startTime && block.endTime ? `${block.startTime}–${block.endTime}` : "Todo el día";
}

/** What the calendar writes on a block: "Vacaciones", "Salón cerrado — Navidad". */
export function calendarLabel(block: Pick<TimeOff, "professionalId" | "kind" | "note">): string {
  if (block.professionalId === null) {
    const note = block.note?.trim();
    return note ? `Salón cerrado — ${note}` : "Salón cerrado";
  }
  return TIME_OFF_KIND_LABELS[block.kind] ?? "Ausencia";
}

/** Still ahead or happening on `today`: what the lists show. */
export function isCurrentOrUpcoming(block: Pick<TimeOff, "endDate">, today: string): boolean {
  return block.endDate >= today;
}

/**
 * Why the form cannot be sent, in Spanish; null when it can. The same rules
 * the server applies (it answers 400 with these words otherwise).
 */
export function timeOffFormProblem(input: {
  startDate: string;
  endDate: string;
  allDay: boolean;
  startTime: string;
  endTime: string;
  note: string;
}): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(input.endDate)) {
    return "Elige las fechas.";
  }
  if (input.endDate < input.startDate) return "La fecha de fin no puede ser anterior a la de inicio.";
  if (daysInRange(input.startDate, input.endDate) > MAX_SPAN_DAYS) {
    return `Una ausencia puede durar como máximo ${MAX_SPAN_DAYS} días.`;
  }
  if (!input.allDay) {
    if (input.startDate !== input.endDate) return "Las horas solo se pueden indicar para un único día.";
    if (!/^\d{2}:\d{2}$/.test(input.startTime) || !/^\d{2}:\d{2}$/.test(input.endTime)) {
      return "Indica la hora de inicio y la de fin.";
    }
    if (input.endTime <= input.startTime) return "La hora de fin tiene que ser posterior a la de inicio.";
  }
  if (input.note.trim().length > 200) return "La nota puede tener como máximo 200 caracteres.";
  return null;
}

/** "Esta cita coincide…" / "Estas 3 citas coinciden…", for the confirmation. */
export function conflictTitle(count: number, what: "ausencia" | "cierre"): string {
  const with_ = what === "cierre" ? "con el cierre" : "con la ausencia";
  return count === 1 ? `Esta cita coincide ${with_}` : `Estas ${count} citas coinciden ${with_}`;
}

/** One clash as a line: "14 dic 2026 · 10:00 · Lucía Pérez · Corte, Color (Ana Gil)". */
export function conflictLine(c: TimeOffConflict): string {
  const services = c.serviceNames.length ? ` · ${c.serviceNames.join(", ")}` : "";
  const who = c.professionalName ? ` (${c.professionalName})` : "";
  return `${shortDay(c.date)} · ${c.time} · ${c.clientName}${services}${who}`;
}
