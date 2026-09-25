import {
  parseJwtDuration,
  DEFAULT_ACCESS_TOKEN_SECONDS,
  DEFAULT_REFRESH_TOKEN_SECONDS,
} from './jwt-duration';

/**
 * Pins the behaviour the two `parseInt` call sites got wrong: a unit
 * suffix must scale the value, not be silently truncated off it.
 */
describe('parseJwtDuration', () => {
  it('reads the documented JWT_EXPIRES_IN=8h as eight hours', () => {
    // The whole point. parseInt("8h") * 60 gave 480 seconds -- 8 minutes.
    expect(parseJwtDuration('8h', 0)).toBe(8 * 60 * 60);
    expect(parseJwtDuration('8h', 0)).not.toBe(8 * 60);
  });

  it('scales each supported unit', () => {
    expect(parseJwtDuration('30s', 0)).toBe(30);
    expect(parseJwtDuration('15m', 0)).toBe(15 * 60);
    expect(parseJwtDuration('1h', 0)).toBe(60 * 60);
    expect(parseJwtDuration('7d', 0)).toBe(7 * 24 * 60 * 60);
  });

  it('treats a bare number as seconds', () => {
    // So `JWT_EXPIRES_IN=15` is fifteen seconds, not fifteen minutes.
    // The compose file leaves the variable empty rather than defaulting
    // it to a bare number for this reason.
    expect(parseJwtDuration('900', 0)).toBe(900);
    expect(parseJwtDuration('15', 0)).toBe(15);
  });

  it('is case- and whitespace-insensitive', () => {
    expect(parseJwtDuration('  8H  ', 0)).toBe(8 * 60 * 60);
    expect(parseJwtDuration('7 D', 0)).toBe(7 * 24 * 60 * 60);
  });

  it('falls back on absent, empty or unparseable input', () => {
    for (const raw of [undefined, '', '   ', 'soon', '8 weeks', '-5m', '1.5h']) {
      expect(parseJwtDuration(raw, 4242)).toBe(4242);
    }
  });

  it('exposes the defaults the callers share', () => {
    expect(DEFAULT_ACCESS_TOKEN_SECONDS).toBe(8 * 60 * 60);
    expect(DEFAULT_REFRESH_TOKEN_SECONDS).toBe(7 * 24 * 60 * 60);
  });
});
