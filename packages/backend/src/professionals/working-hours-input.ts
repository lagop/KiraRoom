import { Transform } from "class-transformer";
import { ValidationArguments, registerDecorator } from "class-validator";
import { WorkingHoursEntry, clockOf, minutesOf } from "../appointments/working-hours";

/**
 * A professional's weekly schedule as the API accepts it.
 *
 * `workingHours` used to be `any[]` on every create and update DTO: whatever
 * arrived was stored, and availability then read it. A shift ending before it
 * started, a day called "lunes" or two overlapping afternoons were saved
 * without a word, and the professional quietly stopped being bookable that
 * day (working-hours.ts skips what it cannot read). Now the body is refused
 * with the reason, in the words the salon reads, before anything is written.
 *
 * Several entries for the same day are separate shifts (jornada partida). The
 * value is normalised before it is stored: weekday names in lower case, times
 * as "HH:MM", Monday first and each day's shifts by start time, and nothing
 * but `day`, `openTime` and `closeTime` on each entry.
 */

/** Monday first: how a salon reads its own week, and how it is stored. */
const WEEK = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const DAY_ES: Record<string, string> = {
  monday: "lunes",
  tuesday: "martes",
  wednesday: "miércoles",
  thursday: "jueves",
  friday: "viernes",
  saturday: "sábado",
  sunday: "domingo",
};

/** Three shifts a day, every day: more than any salon has asked for. */
export const MAX_WORKING_HOURS_ENTRIES = 21;

function isEntryShaped(e: unknown): e is WorkingHoursEntry {
  return (
    !!e &&
    typeof e === "object" &&
    !Array.isArray(e) &&
    typeof (e as WorkingHoursEntry).day === "string" &&
    typeof (e as WorkingHoursEntry).openTime === "string" &&
    typeof (e as WorkingHoursEntry).closeTime === "string"
  );
}

/**
 * Why `value` is not a schedule we can store, or null when it is. Run on the
 * normalised value, so "Monday" and "9:00" have already become "monday" and
 * "09:00" by the time they get here.
 */
export function workingHoursProblem(value: unknown): string | null {
  if (!Array.isArray(value)) return "El horario debe ser una lista de tramos.";
  if (value.length > MAX_WORKING_HOURS_ENTRIES) {
    return `El horario admite como máximo ${MAX_WORKING_HOURS_ENTRIES} tramos (tres por día).`;
  }

  const byDay = new Map<string, Array<{ start: number; end: number }>>();
  for (const entry of value) {
    if (!isEntryShaped(entry)) {
      return "Cada tramo del horario necesita día, hora de inicio y hora de fin.";
    }
    const day = entry.day.trim().toLowerCase();
    if (!WEEK.includes(day)) return `"${entry.day}" no es un día de la semana válido.`;
    const start = minutesOf(entry.openTime);
    const end = minutesOf(entry.closeTime);
    if (start === null) return `La hora "${entry.openTime}" no es válida: usa el formato HH:MM.`;
    if (end === null) return `La hora "${entry.closeTime}" no es válida: usa el formato HH:MM.`;
    if (end <= start) {
      return `El tramo del ${DAY_ES[day]} termina (${clockOf(end)}) antes de empezar (${clockOf(start)}).`;
    }
    byDay.set(day, [...(byDay.get(day) ?? []), { start, end }]);
  }

  for (const [day, shifts] of byDay) {
    const sorted = [...shifts].sort((a, b) => a.start - b.start);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      // Touching is fine (10:00–14:00 then 14:00–18:00); overlapping is not:
      // it is almost always a typo, and which one was meant is not ours to guess.
      if (cur.start < prev.end) {
        return (
          `Los tramos del ${DAY_ES[day]} se solapan ` +
          `(${clockOf(prev.start)}–${clockOf(prev.end)} y ${clockOf(cur.start)}–${clockOf(cur.end)}).`
        );
      }
    }
  }
  return null;
}

/**
 * The stored form of a schedule: see the header. Anything that does not look
 * like a list of entries is returned as it came, for `workingHoursProblem` to
 * refuse with a reason rather than be silently "fixed" here.
 */
export function normalizeWorkingHours(value: unknown): unknown {
  if (!Array.isArray(value) || !value.every(isEntryShaped)) return value;
  const entries = value.map((e) => {
    const start = minutesOf(e.openTime);
    const end = minutesOf(e.closeTime);
    return {
      day: e.day.trim().toLowerCase(),
      openTime: start === null ? e.openTime : clockOf(start),
      closeTime: end === null ? e.closeTime : clockOf(end),
    };
  });
  const rank = (day: string) => {
    const i = WEEK.indexOf(day);
    return i === -1 ? WEEK.length : i;
  };
  return entries.sort(
    (a, b) =>
      rank(a.day) - rank(b.day) ||
      (minutesOf(a.openTime) ?? 0) - (minutesOf(b.openTime) ?? 0),
  );
}

/**
 * The salon's pre-shifts `{ open, close }` pair as the week it always meant:
 * every day, those hours. Anything else is returned as it came. The times are
 * copied as sent, so a bad one is refused by workingHoursProblem with its
 * reason rather than dropped here.
 */
export function weekFromOpeningPair(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { open, close } = value as { open?: unknown; close?: unknown };
  if (typeof open !== "string" || typeof close !== "string") return value;
  return WEEK.map((day) => ({ day, openTime: open, closeTime: close }));
}

/**
 * For a DTO's `workingHours`: normalise, then refuse with the reason. Pair it
 * with `@IsOptional()` -- leaving the schedule out of an update keeps it.
 *
 * `legacyOpeningPair` is for the salon's own hours (Tenant.openingHours):
 * clients that still send the old single `{ open, close }` get it stored as
 * the same week in the list format.
 */
export function IsWorkingHours(opts: { legacyOpeningPair?: boolean } = {}): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    Transform(({ value }) =>
      normalizeWorkingHours(opts.legacyOpeningPair ? weekFromOpeningPair(value) : value),
    )(target, propertyKey);
    registerDecorator({
      name: "isWorkingHours",
      target: target.constructor,
      propertyName: propertyKey as string,
      validator: {
        validate: (value: unknown) => workingHoursProblem(value) === null,
        defaultMessage: (args?: ValidationArguments) =>
          workingHoursProblem(args?.value) ?? "El horario no es válido.",
      },
    });
  };
}
