import { BadRequestException } from '@nestjs/common';

/**
 * A salon's own Stripe secret keys (tenants.stripeTestSecretKey and
 * stripeLiveSecretKey).
 *
 * They were stored as typed and sent whole to the browser on every visit to
 * the settings page. Now they are encrypted at rest with EncryptionService
 * (the key that already protects the WhatsApp and channel tokens) and the
 * page only ever gets a masked form, `sk_live_…1234`. Keys saved before
 * this change are still plain text in the database: a value that looks like
 * a Stripe key is read as it is (decrypt-or-passthrough), and is encrypted
 * the next time the salon saves it.
 */

const MASK = '…';
const PLAIN_KEY = /^(sk|rk)_(test|live)_\S+$/;

/** A Stripe secret key as typed (never one of our ciphertexts). */
export function isPlainSecretKey(value: string): boolean {
  return PLAIN_KEY.test(value);
}

/** What the page shows for a stored key: its prefix and last four characters. */
export function maskSecretKey(plain: string | null | undefined): string | null {
  if (!plain) return null;
  const prefix = /^(sk|rk)_(test|live)_/.exec(plain)?.[0] ?? plain.slice(0, 3);
  return `${prefix}${MASK}${plain.slice(-4)}`;
}

/** The page sent back the masked value it was given: the key is unchanged. */
export function isMaskedKey(value: string): boolean {
  return value.includes(MASK);
}

/**
 * The key as Stripe wants it: plain text as stored by older versions, else
 * decrypted. Null when it cannot be read (the encryption key changed).
 */
export function revealSecretKey(
  stored: string | null | undefined,
  decrypt: ((packed: string) => string) | null,
): string | null {
  if (!stored) return null;
  if (isPlainSecretKey(stored)) return stored;
  if (!decrypt) return null;
  try {
    return decrypt(stored);
  } catch {
    return null;
  }
}

/**
 * What to write for one secret-key field of a PATCH: `undefined` leaves the
 * column alone (not sent, or sent back masked), null clears it, a string is
 * a new key to encrypt. A new key must be a Stripe secret key of that mode.
 */
export function secretKeyChange(
  value: unknown,
  mode: 'test' | 'live',
): { kind: 'keep' } | { kind: 'clear' } | { kind: 'set'; plain: string } {
  if (value === undefined) return { kind: 'keep' };
  if (value === null || value === '') return { kind: 'clear' };
  if (typeof value !== 'string') {
    throw new BadRequestException('La clave secreta de Stripe no es válida.');
  }
  const trimmed = value.trim();
  if (!trimmed) return { kind: 'clear' };
  if (isMaskedKey(trimmed)) return { kind: 'keep' };
  if (!isPlainSecretKey(trimmed) || PLAIN_KEY.exec(trimmed)?.[2] !== mode) {
    throw new BadRequestException(
      mode === 'live'
        ? 'La clave secreta de producción debe empezar por sk_live_ (o rk_live_).'
        : 'La clave secreta de pruebas debe empezar por sk_test_ (o rk_test_).',
    );
  }
  return { kind: 'set', plain: trimmed };
}
