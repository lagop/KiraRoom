/**
 * The calendar draws the salon's clock, not the browser's.
 *
 * Appointments are a day plus an "HH:MM" on the salon's wall clock
 * (Tenant.timezone); per-service rows of a visit hold real instants. The
 * calendar used to read the first as the browser's local time and draw the
 * second in the browser's zone. With the browser in the Canaries and the
 * salon on Madrid time, single-service blocks sat an hour off from where the
 * server has them, and the two kinds of block disagreed with each other.
 *
 * Here every block is a real instant, and only drawing turns it into the
 * salon's wall clock. Same arithmetic as the server's salonInstant
 * (backend/src/appointments/salon-time.ts). Pure, so it is tested without a
 * browser (salon-time.spec.ts).
 */

/** Until the salon's own zone is known (Tenant.timezone defaults to it too). */
export const FALLBACK_SALON_TIMEZONE = "Europe/Madrid";

const formatters = new Map<string, Intl.DateTimeFormat>();

function partsIn(instant: number, timeZone: string) {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return { y: get("year"), m: get("month"), d: get("day"), hh: get("hour") % 24, mm: get("minute"), ss: get("second") };
}

/** The UTC offset of `timeZone` at `instant`, in milliseconds. */
function offsetMs(instant: number, timeZone: string): number {
  const p = partsIn(instant, timeZone);
  return Date.UTC(p.y, p.m - 1, p.d, p.hh, p.mm, p.ss) - Math.floor(instant / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, "0");

/** The instant at which the salon's clock reads `time` ("HH:MM") on `day` ("YYYY-MM-DD"). */
export function salonInstant(day: string, time: string, timeZone: string): Date {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wallAsUtc = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes settle the offset across a DST change.
  let instant = wallAsUtc - offsetMs(wallAsUtc, timeZone);
  instant = wallAsUtc - offsetMs(instant, timeZone);
  return new Date(instant);
}

export interface SalonClock {
  /** "YYYY-MM-DD" on the salon's calendar. */
  day: string;
  /** "HH:MM" on the salon's clock. */
  time: string;
  /** Minutes since the salon's midnight. */
  minutes: number;
}

/** What the salon's clock reads at `instant`. */
export function salonClock(instant: Date | string | number, timeZone: string): SalonClock {
  const ms = typeof instant === "number" ? instant : new Date(instant).getTime();
  const p = partsIn(ms, timeZone);
  return {
    day: `${p.y}-${pad(p.m)}-${pad(p.d)}`,
    time: `${pad(p.hh)}:${pad(p.mm)}`,
    minutes: p.hh * 60 + p.mm,
  };
}

/** "HH:MM" on the salon's clock. */
export function salonTime(instant: Date | string | number, timeZone: string): string {
  return salonClock(instant, timeZone).time;
}

/**
 * The calendar day a picked date stands for. The date pickers hand over a
 * Date at the browser's local midnight; its local calendar day is the salon
 * day the user chose, whatever zone either is in.
 */
export function pickedDay(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * The `startDate`/`endDate` for one salon day of GET /appointments.
 * The server compares them with `scheduledDate`, a date column read as UTC
 * midnight, so the day is sent as that, not as the browser's midnight (which,
 * west of UTC, fell after it and dropped the whole day).
 */
export function dayQueryRange(day: string): { startDate: string; endDate: string } {
  return { startDate: `${day}T00:00:00.000Z`, endDate: `${day}T23:59:59.999Z` };
}
