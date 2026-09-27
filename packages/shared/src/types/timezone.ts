/**
 * Timezones a salon can be in.
 *
 * There was no way for a Canarian salon to set its own time. The dashboard's
 * settings screen reads `tenant.timezone` and sends it when it changes, but
 * has no control that changes it. The only selector lives in the owner
 * console, and its eight hardcoded options did not include `Atlantic/Canary`.
 * A salon that signed up stayed on `Europe/Madrid` for good.
 *
 * For the Canary Islands that means every appointment an hour off, for ever,
 * and WhatsApp reminders going out at the wrong time — in the market the
 * go-to-market plan recommends starting with.
 *
 * Spain first, because that is the market. Then the two expansion markets the
 * plan names, then the rest. Labels name the territory rather than the zone,
 * because a salon owner knows where they are, not what their tz database
 * identifier is.
 */
export interface TimezoneOption {
  /** IANA identifier, stored as-is on the tenant. */
  value: string;
  /** What a salon owner will recognise. */
  label: string;
}

export const SALON_TIMEZONES: TimezoneOption[] = [
  // Spain. Ceuta and Melilla really are Africa/Ceuta, even though it holds
  // the same offset as Madrid today.
  { value: 'Europe/Madrid', label: 'España — Península y Baleares' },
  { value: 'Atlantic/Canary', label: 'España — Canarias' },
  { value: 'Africa/Ceuta', label: 'España — Ceuta y Melilla' },

  // The first two expansion markets in the plan.
  { value: 'Europe/Lisbon', label: 'Portugal' },
  { value: 'Europe/Rome', label: 'Italia' },

  // Elsewhere.
  { value: 'Europe/London', label: 'Reino Unido' },
  { value: 'Europe/Paris', label: 'Francia' },
  { value: 'Europe/Berlin', label: 'Alemania' },
  { value: 'America/Mexico_City', label: 'México' },
  { value: 'America/Bogota', label: 'Colombia' },
  { value: 'America/Santiago', label: 'Chile' },
  { value: 'America/Argentina/Buenos_Aires', label: 'Argentina' },
  { value: 'America/New_York', label: 'EE. UU. — Este' },
  { value: 'America/Los_Angeles', label: 'EE. UU. — Oeste' },
];

export const DEFAULT_SALON_TIMEZONE = 'Europe/Madrid';

export function isKnownSalonTimezone(value: unknown): boolean {
  return (
    typeof value === 'string' && SALON_TIMEZONES.some((t) => t.value === value)
  );
}

/**
 * The label for a stored value, falling back to the identifier itself.
 *
 * A tenant may hold a zone that is not on this list — `America/Buenos_Aires`
 * was offered by the old console selector and is a deprecated alias of
 * `America/Argentina/Buenos_Aires` — so the label must never come back empty.
 */
export function salonTimezoneLabel(value: string): string {
  return SALON_TIMEZONES.find((t) => t.value === value)?.label ?? value;
}
