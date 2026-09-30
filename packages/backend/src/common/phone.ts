/**
 * Client phone numbers, as clients type them.
 *
 * Online booking and the chat receptionist identify a client by phone when
 * there is no email, so "600 111 222", "+34600111222" and "0034 600 111 222"
 * have to be the same client.
 */

/** Country dialling codes for the markets the salons are in. */
const DIAL_CODES: Record<string, string> = {
  ES: '34',
  PT: '351',
  IT: '39',
  FR: '33',
  MX: '52',
};

/** At least 9 digits (a Spanish number) and at most 15 (E.164). */
export const PHONE_PATTERN = /^(?=(?:\D*\d){9,15}\D*$)[\d\s().+-]+$/;

/**
 * International form when it can be worked out: "+34600111222". A number
 * without a prefix gets the salon's country code; one with "+" or "00"
 * keeps its own. Unknown country: the digits as typed.
 */
export function normalizePhone(raw: string, country = 'ES'): string {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return `+${digits}`;
  if (digits.startsWith('00')) return `+${digits.slice(2)}`;
  const code = DIAL_CODES[country.toUpperCase()];
  return code ? `+${code}${digits}` : digits;
}

/**
 * What two spellings of the same number share: the last nine digits. Enough
 * to tell a salon's clients apart without knowing every country's format.
 */
export function phoneKey(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\D/g, '').slice(-9);
}

export function samePhone(a: string | null | undefined, b: string | null | undefined): boolean {
  const ka = phoneKey(a);
  return ka.length === 9 && ka === phoneKey(b);
}
