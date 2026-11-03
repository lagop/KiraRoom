import {
  ShiftWindow,
  bookableWindows,
  clockOf,
  mergeWindows,
  minutesOf,
  salonWindowsFor,
  subtractWindows,
  workingWindowsFor,
} from '../appointments/working-hours';
import { availableWindows, dayBlocks, salonClosedOn, type TimeOffBlock } from '../time-off/time-off-rules';

/**
 * The free stretches of the copilot's daily briefing, per professional.
 *
 * It used to sort the whole salon's appointments by time and report the
 * space between consecutive ones, so with three stylists Ana's appointment
 * ending as Marta's began read as "no gap" while Lucía's two free hours
 * never showed. Now each professional's day is their bookable hours (their
 * shifts within the salon's hours, minus approved time off and closures)
 * minus their own appointments; what is left, from now on, is a gap.
 *
 * A professional with no schedule recorded anywhere (no shifts and no salon
 * hours) has no known day: only the space between their own appointments
 * counts, as before.
 */
export const MIN_GAP_MINUTES = 30;

export interface BriefingProfessional {
  id: string;
  firstName: string;
  workingHours: unknown;
}

export interface BriefingBusy {
  professionalId: string | null;
  /** "HH:MM" */
  start: string;
  /** Minutes until the professional is free again (length + cleanup). */
  minutes: number;
}

export interface BriefingGap {
  start: string;
  end: string;
  minutes: number;
  professionalId: string;
  professionalFirstName: string;
}

export function briefingGaps(input: {
  /** "YYYY-MM-DD", the salon's today. */
  day: string;
  /** Minutes since midnight now, in the salon's clock: earlier time is gone. */
  nowMinutes: number;
  openingHours: unknown;
  professionals: ReadonlyArray<BriefingProfessional>;
  busy: ReadonlyArray<BriefingBusy>;
  blocks?: ReadonlyArray<TimeOffBlock>;
}): BriefingGap[] {
  const date = new Date(`${input.day}T00:00:00.000Z`);
  const blocks = input.blocks ?? [];
  if (salonClosedOn(blocks, input.day)) return [];
  const salon = salonWindowsFor(input.openingHours, date);
  const gaps: BriefingGap[] = [];

  for (const prof of input.professionals) {
    const busy: ShiftWindow[] = input.busy
      .filter((b) => b.professionalId === prof.id)
      .map((b) => {
        const start = minutesOf(b.start) ?? 0;
        return { startMinutes: start, endMinutes: start + Math.max(0, b.minutes) };
      });

    let day = bookableWindows(workingWindowsFor(prof.workingHours, date), salon);
    day = availableWindows(day, dayBlocks(blocks, input.day, prof.id));

    let free: ShiftWindow[];
    if (day === undefined) {
      // No hours known: only between their own appointments.
      const merged = mergeWindows(busy);
      free = [];
      for (let i = 0; i + 1 < merged.length; i++) {
        free.push({ startMinutes: merged[i].endMinutes, endMinutes: merged[i + 1].startMinutes });
      }
    } else {
      free = subtractWindows(day, busy);
    }

    for (const w of free) {
      const start = Math.max(w.startMinutes, input.nowMinutes);
      const minutes = w.endMinutes - start;
      if (minutes < MIN_GAP_MINUTES) continue;
      gaps.push({
        start: clockOf(start),
        end: clockOf(w.endMinutes),
        minutes,
        professionalId: prof.id,
        professionalFirstName: prof.firstName,
      });
    }
  }

  return gaps.sort((a, b) => a.start.localeCompare(b.start) || a.professionalFirstName.localeCompare(b.professionalFirstName));
}

/** Minutes since midnight of `now` on the clock of `timeZone`. */
export function salonNowMinutes(timeZone: string, now: Date = new Date()): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? 0);
  return h * 60 + m;
}
