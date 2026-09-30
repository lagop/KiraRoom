/**
 * Appointments store a calendar date plus a wall-clock "HH:MM" in the salon's
 * own timezone. Deciding whether one is "at least N hours away" needs the
 * real instant, which depends on the salon's UTC offset on that date --
 * Madrid and Canarias differ by an hour, and both move with DST.
 */

/** The UTC offset of `timeZone` at `instant`, in milliseconds. */
function offsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant at which the salon's clock reads `time` on `date`.
 *
 * `date` is a Date whose UTC calendar day is the appointment's day (how
 * Prisma returns a `@db.Date`) or a "YYYY-MM-DD" string.
 */
export function salonInstant(date: Date | string, time: string, timeZone: string): Date {
  const day = typeof date === "string" ? date.slice(0, 10) : date.toISOString().slice(0, 10);
  const [y, m, d] = day.split("-").map(Number);
  const [hh, mm] = time.split(":").map(Number);
  const wallAsUtc = Date.UTC(y, m - 1, d, hh, mm);
  // Two passes settle the offset across a DST change.
  let instant = wallAsUtc - offsetMs(wallAsUtc, timeZone);
  instant = wallAsUtc - offsetMs(instant, timeZone);
  return new Date(instant);
}
