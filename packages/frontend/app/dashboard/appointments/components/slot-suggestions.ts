/**
 * The new-appointment drawer's suggested times, from the server's free
 * slots (GET /appointments/available-slots).
 *
 * The drawer used to run its own scheduler (lib/appointment-scheduler*.ts):
 * it read an `operatingHours` field the salon does not have, merged the
 * server's half-hour slots into windows of its own, and so offered times the
 * server then refused, or missed ones it would have taken. The server
 * already knows the shifts, the opening hours and every booking, so the
 * drawer now only asks it and picks from the answer. Pure: tested in
 * slot-suggestions.spec.ts.
 *
 * Only the visit's first service is checked: the server times the rest when
 * the appointment is created, and refuses it with its reason if they do not
 * fit.
 */
import { shiftDay } from "../../../../components/Calendar/day-grid";
import { addMinutesToTime } from "./appointment-drawer.utils";

/** Where the afternoon starts, as salons in Spain split the day. */
export const AFTERNOON_FROM = 14 * 60;

const DAY_END = 24 * 60;

/** How many days "next available" looks ahead. */
export const SEARCH_DAYS = 7;

/** How many times the drawer offers. */
export const MAX_SUGGESTIONS = 8;

export interface TimePreference {
  type: string;
  morningPreferred: boolean;
  afternoonPreferred: boolean;
  specificDate: string;
  specificTimePeriod: string;
}

export interface SlotSearch {
  /** Days to ask about, in order ("yyyy-MM-dd"). */
  days: string[];
  /** Minutes since midnight, [from, to). */
  from: number;
  to: number;
}

function minutesOf(time: string): number | null {
  const m = /^(\d{1,2}):(\d{2})/.exec(time);
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/**
 * Which days to ask about and which part of the day suits, for the drawer's
 * time preference. Null when the preference is not complete yet (a specific
 * day without its time of day).
 */
export function planSlotSearch(
  pref: TimePreference,
  today: string,
  searchDays: number = SEARCH_DAYS,
): SlotSearch | null {
  const allDay = { from: 0, to: DAY_END };
  const morning = { from: 0, to: AFTERNOON_FROM };
  const afternoon = { from: AFTERNOON_FROM, to: DAY_END };
  const ahead = Array.from({ length: searchDays }, (_, i) => shiftDay(today, i));

  switch (pref.type) {
    case "today_morning":
      return { days: [today], ...morning };
    case "today_afternoon":
      return { days: [today], ...afternoon };
    case "flexible": {
      // One of the two ticked: that half of the day; both or neither: any time.
      const window =
        pref.morningPreferred === pref.afternoonPreferred
          ? allDay
          : pref.morningPreferred
            ? morning
            : afternoon;
      return { days: ahead, ...window };
    }
    case "specific": {
      if (!pref.specificDate || !pref.specificTimePeriod) return null;
      const period = pref.specificTimePeriod;
      if (period === "morning") return { days: [pref.specificDate], ...morning };
      if (period === "evening") return { days: [pref.specificDate], ...afternoon };
      const start = minutesOf(period);
      if (start === null) return null;
      // An hour picked: the slots inside that hour.
      return { days: [pref.specificDate], from: start, to: start + 60 };
    }
    default:
      // "next_available"
      return { days: ahead, ...allDay };
  }
}

/** The start times the server says are free. */
export function freeTimes(
  slots: ReadonlyArray<{ time: string; isAvailable?: boolean }> | null | undefined,
): string[] {
  return (slots ?? []).filter((s) => s.isAvailable !== false).map((s) => s.time);
}

/** Whether `time` on `day` suits the search, and has not passed yet. */
export function suits(
  time: string,
  day: string,
  search: SlotSearch,
  now: { day: string; minutes: number },
): boolean {
  const minutes = minutesOf(time);
  if (minutes === null) return false;
  if (minutes < search.from || minutes >= search.to) return false;
  if (day < now.day) return false;
  return day !== now.day || minutes >= now.minutes;
}

export interface ProfessionalSlots {
  /** Empty when the server was asked for anyone. */
  professionalId: string;
  name: string;
  times: string[];
}

export interface SlotSuggestion {
  id: string;
  date: string;
  startTime: string;
  endTime: string;
  /** Who is free then; absent when the server was asked for anyone. */
  professionalId?: string;
  professionalName?: string;
}

/**
 * The times to offer on `day`: each free start that suits the search, once,
 * with the first professional (in the order given) who is free then.
 */
export function buildSlotSuggestions(input: {
  day: string;
  search: SlotSearch;
  now: { day: string; minutes: number };
  /** The visit's length, for the end time shown. */
  durationMinutes: number;
  byProfessional: ReadonlyArray<ProfessionalSlots>;
  max?: number;
}): SlotSuggestion[] {
  const byTime = new Map<string, ProfessionalSlots>();
  for (const professional of input.byProfessional) {
    for (const time of professional.times) {
      if (byTime.has(time)) continue;
      if (!suits(time, input.day, input.search, input.now)) continue;
      byTime.set(time, professional);
    }
  }
  return Array.from(byTime.entries())
    .sort(([a], [b]) => (minutesOf(a) ?? 0) - (minutesOf(b) ?? 0))
    .slice(0, input.max ?? MAX_SUGGESTIONS)
    .map(([time, professional]) => ({
      id: `${input.day}T${time}${professional.professionalId ? `-${professional.professionalId}` : ""}`,
      date: input.day,
      startTime: time,
      endTime: addMinutesToTime(time, Math.max(0, input.durationMinutes)),
      ...(professional.professionalId
        ? { professionalId: professional.professionalId, professionalName: professional.name }
        : {}),
    }));
}

/**
 * The professionals to ask about for a service: the one chosen, else those
 * who offer it, else everyone (the server's rule for a service nobody is
 * linked to).
 */
export function candidateProfessionals<
  P extends { id: string; services?: ReadonlyArray<{ serviceId: string }> },
>(professionals: ReadonlyArray<P>, serviceId: string, chosenId?: string): P[] {
  if (chosenId) return professionals.filter((p) => p.id === chosenId);
  const offering = professionals.filter((p) => p.services?.some((s) => s.serviceId === serviceId));
  return offering.length > 0 ? offering : [...professionals];
}
