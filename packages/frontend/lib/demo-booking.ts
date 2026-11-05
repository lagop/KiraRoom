/**
 * The booking demo linked from the landing page ("Ver demo de reservas",
 * app/example-booking). It used invented ids ("salon-1") against the real
 * availability endpoint, which answered 400: the demo never showed a time
 * and raised an error toast -- the first thing a salon owner tries. It is a
 * demo, so it now uses example times computed here, never the API, and says
 * plainly that nothing is booked.
 *
 * No React here, so lib/demo-booking.spec.ts can run it.
 */
import { parseDateOnly } from "./public-booking";

/** Morning and afternoon, every half hour; a few taken, as in a real day. */
const MORNING = ["10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "13:30"];
const AFTERNOON = ["16:00", "16:30", "17:00", "17:30", "18:00", "18:30", "19:00", "19:30"];

/**
 * Example free times for a "YYYY-MM-DD" day: none on Sundays, mornings only
 * on Saturdays, and a different few taken each day (the same ones every time
 * for that day).
 */
export function demoSlots(date: string): string[] {
  const d = parseDateOnly(date);
  if (!d) return [];
  const weekday = d.getDay();
  if (weekday === 0) return [];
  const day = weekday === 6 ? MORNING : [...MORNING, ...AFTERNOON];
  const seed = d.getDate();
  return day.filter((_t, i) => (i * 7 + seed) % 5 !== 0);
}
