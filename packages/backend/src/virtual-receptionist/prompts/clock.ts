/**
 * What the receptionist is told about "now", on every turn.
 *
 * It used to get a bare UTC instant ("[2026-09-29T11:29:03.123Z]") and had to
 * work out the salon's local date, the weekday and every "el jueves" itself.
 * In a real chat it offered "25 de septiembre" and "2 de octubre" as the next
 * Thursdays -- neither is one, and the first had already passed. So the
 * server does the calendar: today's date and time in the salon's timezone,
 * with the weekday, and the next two weeks spelled out.
 *
 * It rides on the user turn, not in the system prompt, so the cacheable
 * prefix stays byte-stable.
 */
export function salonClock(now: Date, timeZone: string, language: string, days = 14): string {
  const locale = language === 'en' ? 'en-GB' : 'es-ES';
  const tz = timeZone || 'Europe/Madrid';

  const today = new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  }).format(now);
  const time = new Intl.DateTimeFormat(locale, {
    timeZone: tz,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(now);
  const isoDay = (d: Date) =>
    new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  const weekday = (d: Date) => new Intl.DateTimeFormat(locale, { timeZone: tz, weekday: 'long' }).format(d);

  // Noon steps avoid landing on the wrong side of a DST change.
  const upcoming: string[] = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(now.getTime() + i * 86_400_000);
    upcoming.push(`${weekday(d)} ${isoDay(d)}`);
  }

  return language === 'en'
    ? `[Now at the salon: ${today}, ${time} (${tz}). Today is ${isoDay(now)}. ` +
        `Next days: ${upcoming.join(', ')}. Use these dates; do not work weekdays out yourself. The list is not a booking limit: for a later date, check_availability says whether it can be booked.]`
    : `[Ahora en el salón: ${today}, ${time} (${tz}). Hoy es ${isoDay(now)}. ` +
        `Próximos días: ${upcoming.join(', ')}. Usa estas fechas; no calcules tú los días de la semana. La lista no es un límite de reserva: para una fecha posterior, check_availability dice si se puede reservar.]`;
}
