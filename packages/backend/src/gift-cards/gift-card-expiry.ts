import { salonInstant } from "../appointments/salon-time";

/**
 * A gift card's expiry is a calendar day in the salon's own timezone: a card
 * "valid until 31/12/2026" works the whole of that day in the salon. It is
 * stored as the last millisecond of that day (salon time), so "expired" is
 * simply `expiresAt < now`.
 *
 * It used to be stored as midnight UTC at the start of the day, so the card
 * stopped working on its last day (from 01:00 in Madrid).
 */

/** How long a card is valid when the salon does not pick a date. */
export const DEFAULT_GIFT_CARD_VALIDITY_YEARS = 2;

const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** `timeZone` if the runtime knows it, else Madrid (never throws). */
export function safeTimeZone(timeZone: string | null | undefined): string {
  if (timeZone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone });
      return timeZone;
    } catch {
      // fall through
    }
  }
  return "Europe/Madrid";
}

/** The salon's calendar day ("YYYY-MM-DD") at `instant`. */
export function salonDay(instant: Date, timeZone: string): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: safeTimeZone(timeZone),
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(instant);
}

function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/**
 * The day part of what the panel or the POS sent ("2026-12-31", or an ISO
 * instant whose date is that day), or null when it is not a real date.
 */
export function parseExpiryDay(value: string): string | null {
  const m = DAY_RE.exec(String(value ?? "").trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d) {
    return null;
  }
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** The last millisecond of `day` in the salon's timezone. */
export function endOfSalonDay(day: string, timeZone: string): Date {
  const nextMidnight = salonInstant(addDays(day, 1), "00:00", safeTimeZone(timeZone));
  return new Date(nextMidnight.getTime() - 1);
}

/** The default expiry day: today in the salon plus the default validity. */
export function defaultExpiryDay(timeZone: string, now: Date = new Date()): string {
  const [y, m, d] = salonDay(now, timeZone).split("-").map(Number);
  // 29 Feb rolls to 1 Mar, never to an earlier day.
  return new Date(Date.UTC(y + DEFAULT_GIFT_CARD_VALIDITY_YEARS, m - 1, d))
    .toISOString()
    .slice(0, 10);
}

/** Whether `day` is before today in the salon. */
export function isPastDay(day: string, timeZone: string, now: Date = new Date()): boolean {
  return day < salonDay(now, timeZone);
}

/** The salon calendar day a stored expiry falls on, for display. */
export function expiryDayOf(expiresAt: Date | null, timeZone: string): string | null {
  return expiresAt ? salonDay(expiresAt, timeZone) : null;
}
