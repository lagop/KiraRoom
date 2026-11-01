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

/**
 * A phone number as a log line may show it: "+34 6•• ••• 222". The country
 * code (when the number has one), the first digit and the last three stay;
 * the rest is hidden. A Twilio "whatsapp:" address keeps its prefix. Server
 * logs are kept and read outside the salon, so a full number does not
 * belong in them.
 */
export function maskPhone(raw: string | null | undefined): string {
  if (raw === null || raw === undefined) return '(sin teléfono)';
  let s = String(raw).trim();
  const channel = /^whatsapp:/i.test(s) ? 'whatsapp:' : '';
  s = s.replace(/^whatsapp:/i, '').trim();
  let digits = s.replace(/\D/g, '');
  if (digits.length < 6) return `${channel}${'•'.repeat(Math.max(digits.length, 3))}`;
  let country = '';
  const international = s.startsWith('+') || digits.startsWith('00');
  if (digits.startsWith('00')) digits = digits.slice(2);
  if (international || (digits.length === 11 && digits.startsWith('34'))) {
    const code =
      Object.values(DIAL_CODES)
        .sort((a, b) => b.length - a.length)
        .find((c) => digits.startsWith(c) && digits.length - c.length >= 6) ?? digits.slice(0, 2);
    country = `+${code} `;
    digits = digits.slice(code.length);
  }
  // The first digit, the hidden middle in threes, the last three: 6•• ••• 222.
  const head = `${digits[0]}${'•'.repeat(digits.length - 4)}`;
  return `${channel}${country}${head.match(/.{1,3}/g)!.join(' ')} ${digits.slice(-3)}`;
}

/**
 * Masks every phone number inside a text (a provider's error message such
 * as "The 'To' number +34600111222 is not a valid phone number"), so it can
 * go to the log. A run of 9 to 15 digits, with the usual separators, counts
 * as a number.
 */
export function maskPhonesIn(text: string | null | undefined): string {
  return String(text ?? '').replace(/(?:whatsapp:)?\+?\d[\d\s().-]{7,}\d/gi, (match) => {
    const count = match.replace(/\D/g, '').length;
    return count >= 9 && count <= 15 ? maskPhone(match) : match;
  });
}
