/**
 * Date and message helpers shared by the screens where a client books on
 * her own: the salon's public page, the client area's new-appointment page
 * and the embeddable widget.
 *
 * Every date here is a calendar day, "YYYY-MM-DD", read in the visitor's
 * local calendar. The screens used to get it from `toISOString()`, which is
 * UTC: between midnight and 01:00/02:00 in Spain "tomorrow" was today and
 * the date picker's minimum was yesterday. And they took the weekday from
 * `new Date("2026-11-01").getDay()`, which parses the string as UTC
 * midnight, so west of Greenwich every day was read as the one before.
 *
 * No React and no Next imports, so lib/public-booking-payload.spec.ts can
 * run them.
 */

import { appBaseUrl } from "./salon-seo";

/** Weekday name (lower-case English) -> window. Absent day = closed. */
export type OpeningHours =
  | Record<string, { openTime: string; closeTime: string }>
  | null
  | undefined;

/** Index 0 is Sunday, matching `Date.prototype.getDay`. */
const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

const pad = (n: number) => String(n).padStart(2, "0");

/** "YYYY-MM-DD" of `d` in the local calendar (not UTC). */
export function localDateString(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** The local calendar day after `now`. */
export function localTomorrow(now: Date = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return localDateString(d);
}

/**
 * A "YYYY-MM-DD" string as a local Date at midnight, or null when it is not
 * a real calendar day ("2026-02-30" is rejected, not rolled over).
 */
export function parseDateOnly(value: string | null | undefined): Date | null {
  const m = DATE_ONLY.exec(value ?? "");
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(y, mo - 1, d);
  if (date.getFullYear() !== y || date.getMonth() !== mo - 1 || date.getDate() !== d) {
    return null;
  }
  return date;
}

/**
 * The day a link asks for (?date= in wait-list notices and rebooking
 * reminders), or "" when it is missing, malformed or already past.
 */
export function bookingDateFromQuery(
  value: string | null | undefined,
  today: string = localDateString(),
): string {
  if (!value || !parseDateOnly(value)) return "";
  // Both are YYYY-MM-DD, so the string order is the date order.
  return value < today ? "" : value;
}

/** "monday" ... for a "YYYY-MM-DD" day, from its calendar parts. */
export function weekdayKey(date: string): string | null {
  const d = parseDateOnly(date);
  return d ? WEEKDAYS[d.getDay()] : null;
}

/**
 * True when the salon is closed that day: a closure it recorded (holidays,
 * closures: `closedDays`, "YYYY-MM-DD"), or its recorded hours say it does
 * not open that weekday. No hours recorded means we do not know, and then no
 * weekday is called closed: the availability endpoint decides. Only picks the
 * message; the slots come from the server either way.
 */
export function isClosedDay(
  date: string,
  hours: OpeningHours,
  closedDays: ReadonlyArray<string> = [],
): boolean {
  if (date && closedDays.includes(date.slice(0, 10))) return true;
  if (!hours || Object.keys(hours).length === 0) return false;
  const key = weekdayKey(date);
  if (!key) return false;
  return !hours[key];
}

/** "domingo, 1 de noviembre de 2026" for a "YYYY-MM-DD" day. */
export function formatBookingDate(date: string, locale = "es-ES"): string {
  const d = parseDateOnly(date.slice(0, 10));
  if (!d) return "";
  return d.toLocaleDateString(locale, {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/**
 * What the time picker says when it has no time to offer. One message for
 * every case was wrong: "choose a service first" while the slots were
 * loading, or for a day the professional is fully booked.
 */
export type SlotsState =
  | "select_service_first"
  | "select_professional_first"
  | "loading_slots"
  | "closed_day"
  | "no_slots"
  | "ready";

export function slotsState(input: {
  serviceId: string;
  professionalId: string;
  date: string;
  loading: boolean;
  slots: ReadonlyArray<{ available: boolean }>;
  closed: boolean;
}): SlotsState {
  if (!input.serviceId) return "select_service_first";
  if (!input.professionalId || !input.date) return "select_professional_first";
  if (input.loading) return "loading_slots";
  if (input.slots.some((s) => s.available)) return "ready";
  return input.closed ? "closed_day" : "no_slots";
}

/** True when `time` is one of the slots the server offered as free. */
export function isOfferedTime(
  time: string,
  slots: ReadonlyArray<{ time: string; available: boolean }>,
): boolean {
  return !!time && slots.some((s) => s.time === time && s.available);
}

/**
 * The server's validation messages, minus the field path NestJS puts in
 * front of a nested one: "clientInfo.Introduce un teléfono válido" ->
 * "Introduce un teléfono válido". Several messages arrive joined with ". ".
 */
export function bookingErrorMessage(raw: string | string[] | null | undefined): string {
  const parts = Array.isArray(raw) ? raw : String(raw ?? "").split(". ");
  return parts
    .map((p) => p.replace(/^(?:[A-Za-z_$][\w$]*\.)+(?=\S)/, "").trim())
    .filter(Boolean)
    .join(". ");
}

/** The calendar day of an appointment's scheduledDate ("2026-11-02T00:00:00.000Z" -> "2026-11-02"). */
export function appointmentDay(scheduledDate: string): string {
  return String(scheduledDate ?? "").slice(0, 10);
}

/** Soonest first, by day and then by time ("09:30" before "17:00"). */
export function compareAppointmentsAsc(
  a: { scheduledDate: string; scheduledTime: string },
  b: { scheduledDate: string; scheduledTime: string },
): number {
  const byDay = appointmentDay(a.scheduledDate).localeCompare(appointmentDay(b.scheduledDate));
  if (byDay !== 0) return byDay;
  return (a.scheduledTime ?? "").localeCompare(b.scheduledTime ?? "");
}

/**
 * The privacy policy the booking forms link to. Absolute, on the app's own
 * host: on a salon's domain or subdomain every path is rewritten under
 * /sites/<slug>, where /legal/privacy does not exist.
 */
export function privacyPolicyUrl(base = appBaseUrl()): string {
  return `${base}/legal/privacy`;
}
