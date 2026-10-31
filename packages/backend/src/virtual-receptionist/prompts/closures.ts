import { dateOfDay, dayOf } from '../../time-off/time-off-rules';

/**
 * What the receptionist is told about the salon's upcoming closures.
 *
 * It knew the weekly hours but not a closure the owner recorded (Navidad, a
 * refurbishment): asked for 24 December it ran check_availability, found no
 * slot, and told the client nothing was free -- never that the salon is shut
 * that day. The approved closures of the next weeks are now spelled out.
 *
 * Salon closures only. A professional's absence is never in it, not even as
 * dates: its reason can be health data (a baja), and the tools already stop
 * anyone booking her those days. A closure's note is left out too: the
 * client is told the salon is closed, not why.
 *
 * Like salonClock, it rides on the user turn, not in the system prompt: the
 * list moves as the days pass, and the system prompt has to stay byte-stable
 * for the cache prefix.
 */

/** How far ahead the receptionist is told about closures. */
export const CLOSURE_HORIZON_DAYS = 60;

/** At most this many closures are listed, so a salon's backlog cannot bloat the turn. */
const MAX_CLOSURES = 15;

/** A salon closure as the receptionist needs it: dates and hours, nothing else. */
export interface SalonClosure {
  startDate: Date | string;
  endDate: Date | string;
  startTime?: string | null;
  endTime?: string | null;
}

const MONTHS: Record<'es' | 'en', string[]> = {
  es: ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
};

/** The salon's calendar day for `now` ("YYYY-MM-DD"). */
function salonDay(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'Europe/Madrid',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function plusDays(day: string, days: number): string {
  const date = dateOfDay(day) as Date;
  return new Date(date.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

const dayNumber = (day: string) => Number(day.slice(8, 10));
const monthName = (day: string, lang: 'es' | 'en') => MONTHS[lang][Number(day.slice(5, 7)) - 1];

/** "Cerrado del 24 al 26 de diciembre (2026-12-24 a 2026-12-26)", and its English twin. */
function describeClosure(start: string, end: string, closure: SalonClosure, lang: 'es' | 'en'): string {
  const hours = closure.startTime && closure.endTime ? { from: closure.startTime, to: closure.endTime } : null;
  if (start === end) {
    if (lang === 'en') {
      const span = hours ? ` from ${hours.from} to ${hours.to}` : '';
      return `Closed on ${dayNumber(start)} ${monthName(start, lang)}${span} (${start})`;
    }
    const span = hours ? ` de ${hours.from} a ${hours.to}` : '';
    return `Cerrado el ${dayNumber(start)} de ${monthName(start, lang)}${span} (${start})`;
  }
  const sameMonth = start.slice(0, 7) === end.slice(0, 7);
  if (lang === 'en') {
    const from = sameMonth ? `${dayNumber(start)}` : `${dayNumber(start)} ${monthName(start, lang)}`;
    return `Closed from ${from} to ${dayNumber(end)} ${monthName(end, lang)} (${start} to ${end})`;
  }
  const from = sameMonth ? `${dayNumber(start)}` : `${dayNumber(start)} de ${monthName(start, lang)}`;
  return `Cerrado del ${from} al ${dayNumber(end)} de ${monthName(end, lang)} (${start} a ${end})`;
}

/**
 * The closures that end today or later and start within the horizon, as one
 * bracketed line for the user turn; '' when there are none, so a salon with
 * no closures sends exactly what it sent before. A closure already under way
 * is described from today.
 */
export function salonClosuresNotice(
  closures: ReadonlyArray<SalonClosure>,
  now: Date,
  timeZone: string,
  language: string,
  horizonDays = CLOSURE_HORIZON_DAYS,
): string {
  const lang = language === 'en' ? 'en' : 'es';
  const today = salonDay(now, timeZone);
  const last = plusDays(today, horizonDays);

  const lines = closures
    .map((c) => ({ closure: c, start: dayOf(c.startDate), end: dayOf(c.endDate) }))
    .filter(({ start, end }) => !!dateOfDay(start) && !!dateOfDay(end) && end >= today && start <= last)
    .sort((a, b) => a.start.localeCompare(b.start) || (a.closure.startTime ?? '').localeCompare(b.closure.startTime ?? ''))
    .slice(0, MAX_CLOSURES)
    .map(({ closure, start, end }) => describeClosure(start < today ? today : start, end, closure, lang));

  if (lines.length === 0) return '';
  return lang === 'en'
    ? `[Salon closures in the next ${horizonDays} days: ${lines.join('; ')}. The salon is closed then: if the client asks for one of those days or hours, say so and offer another date. Do not make up a reason.]`
    : `[Cierres del salón en los próximos ${horizonDays} días: ${lines.join('; ')}. Esos días u horas el salón está cerrado: si el cliente pide uno, díselo y ofrécele otra fecha. No inventes el motivo.]`;
}
