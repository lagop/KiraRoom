import { normalizePhone, PHONE_PATTERN, phoneKey, samePhone } from './phone';

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
