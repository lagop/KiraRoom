import { maskPhone, maskPhonesIn, normalizePhone, PHONE_PATTERN, phoneKey, samePhone } from './phone';

describe('client phone numbers', () => {
  it.each(['600 111 222', '+34 600 111 222', '0034600111222', '+34-600-111-222', '(+34) 600111222'])(
    'reads %p as the same Spanish number',
    (raw) => {
      expect(samePhone(raw, '600111222')).toBe(true);
    },
  );

  it('gives an unprefixed number the salon country code', () => {
    expect(normalizePhone('600 111 222')).toBe('+34600111222');
    expect(normalizePhone('912 345 678', 'PT')).toBe('+351912345678');
  });

  it('keeps a number that already says its country', () => {
    expect(normalizePhone('+44 7700 900123')).toBe('+447700900123');
    expect(normalizePhone('0044 7700 900123')).toBe('+447700900123');
  });

  it('tells different numbers apart', () => {
    expect(samePhone('600111222', '600111223')).toBe(false);
    expect(samePhone('', '')).toBe(false);
    expect(phoneKey(null)).toBe('');
  });

  it.each(['600111222', '+34 600 111 222', '(+34) 600-111-222'])('accepts %p', (raw) => {
    expect(PHONE_PATTERN.test(raw)).toBe(true);
  });

  it.each(['12345', 'no tengo', '600 111 22a', '+'])('rejects %p', (raw) => {
    expect(PHONE_PATTERN.test(raw)).toBe(false);
  });
});

describe('phone numbers in the logs', () => {
  it.each([
    ['+34600111222', '+34 6•• ••• 222'],
    ['+34 600 111 222', '+34 6•• ••• 222'],
    ['0034 600 111 222', '+34 6•• ••• 222'],
    ['34600111222', '+34 6•• ••• 222'],
    ['600111222', '6•• ••• 222'],
    ['whatsapp:+34600111222', 'whatsapp:+34 6•• ••• 222'],
    ['+351912345678', '+351 9•• ••• 678'],
    ['+447700900123', '+44 7•• ••• • 123'],
  ])('masks %p as %p', (raw, masked) => {
    expect(maskPhone(raw)).toBe(masked);
  });

  it('never shows more than the first digit and the last three of the number', () => {
    const masked = maskPhone('+34 612 345 678');
    expect(masked).not.toContain('2345');
    expect(masked.replace(/\D/g, '')).toBe('346678');
  });

  it('short or missing values give nothing away', () => {
    expect(maskPhone('12')).toBe('•••');
    expect(maskPhone(null)).toBe('(sin teléfono)');
  });

  it('masks the numbers inside a provider error, and leaves the rest', () => {
    expect(maskPhonesIn("The 'To' number +34600111222 is not a valid phone number. Code 21211")).toBe(
      "The 'To' number +34 6•• ••• 222 is not a valid phone number. Code 21211",
    );
    expect(maskPhonesIn('Twilio could not find a Channel with the From address whatsapp:+34600111222')).toBe(
      'Twilio could not find a Channel with the From address whatsapp:+34 6•• ••• 222',
    );
    expect(maskPhonesIn(undefined)).toBe('');
  });
});
