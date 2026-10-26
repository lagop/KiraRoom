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

/** Where a salon is, as its address fields hold it. Every field is optional. */
export interface SalonAddress {
  street?: string | null;
  city?: string | null;
  postalCode?: string | null;
  state?: string | null;
  country?: string | null;
}

/**
 * Places that only exist in the Canary Islands: the islands, the two
 * provinces and the larger towns. Accents and case are ignored. "Palma" alone
 * is Mallorca, so only "La Palma" (the island) counts.
 */
const CANARY_PLACES = [
  'canarias',
  'islas canarias',
  'gran canaria',
  'las palmas',
  'las palmas de gran canaria',
  'tenerife',
  'santa cruz de tenerife',
  'lanzarote',
  'fuerteventura',
  'la palma',
  'la gomera',
  'el hierro',
  'la graciosa',
  'arrecife',
  'puerto del rosario',
  'san cristobal de la laguna',
  'telde',
  'arona',
  'adeje',
  'maspalomas',
  'san bartolome de tirajana',
  'santa lucia de tirajana',
  'puerto de la cruz',
  'la orotava',
  'los llanos de aridane',
  'granadilla de abona',
  'icod de los vinos',
  'arucas',
  'aguimes',
  'galdar',
  'mogan',
  'corralejo',
  'teguise',
  'yaiza',
];

function normalisePlace(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Whether a Spanish address is in the Canary Islands: a postcode of the two
 * Canarian provinces (35 Las Palmas, 38 Santa Cruz de Tenerife), or a place
 * name that only exists there. An address in another country never is.
 */
export function isCanaryIslandsAddress(address: SalonAddress): boolean {
  const country = (address.country ?? '').trim().toUpperCase();
  if (country && country !== 'ES' && country !== 'ESPAÑA' && country !== 'SPAIN') return false;

  const postcode = (address.postalCode ?? '').replace(/\s+/g, '');
  if (/^\d{5}$/.test(postcode)) return /^(35|38)/.test(postcode);
  // A postcode written into the street line ("C/ Triana 12, 35002").
  const inStreet = (address.street ?? '').match(/\b(\d{5})\b/);
  if (inStreet && /^(35|38)/.test(inStreet[1])) return true;

  const words = ` ${[address.city, address.state, address.street].filter(Boolean).map((t) => normalisePlace(t as string)).join(' ')} `;
  return CANARY_PLACES.some((place) => words.includes(` ${place} `));
}

/**
 * The timezone a salon should be on, when the one it has is clearly wrong for
 * its address; otherwise null.
 *
 * Every sign-up starts on Europe/Madrid, so a salon in Las Palmas kept
 * Peninsula time and saw its calendar and reminders an hour off. Only that
 * case is corrected: a salon that chose any other zone keeps it.
 */
export function suggestedSalonTimezone(current: string | null | undefined, address: SalonAddress): string | null {
  if ((current || DEFAULT_SALON_TIMEZONE) !== 'Europe/Madrid') return null;
  return isCanaryIslandsAddress(address) ? 'Atlantic/Canary' : null;
}
