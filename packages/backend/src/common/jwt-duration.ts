/**
 * Single reading of the JWT_EXPIRES_IN / JWT_REFRESH_EXPIRES_IN values.
 *
 * There were three, and they disagreed. With the documented
 * `JWT_EXPIRES_IN=8h`:
 *
 *   auth.service.ts   parseJwtDuration("8h", 8h)                 -> 8 hours
 *   app.module.ts     parseInt("8h") * 60                        -> 8 minutes
 *   invites.service   parseInt("8h".replace("m","")) * 60        -> 8 minutes
 *
 * `parseInt` stops at the first non-digit, so the unit suffix was read as
 * the value's own magnitude. Anyone who joined through a SaaS invite got
 * an 8-minute access token and was logged out partway through onboarding,
 * while someone who signed in normally got the intended 8 hours.
 *
 * This is now the only implementation. Callers pass their own fallback in
 * seconds so the defaults stay visible at the call site.
 */
export function parseJwtDuration(
  raw: string | undefined,
  fallbackSeconds: number,
): number {
  if (!raw) return fallbackSeconds;
  const trimmed = raw.trim();
  if (!trimmed) return fallbackSeconds;
  const match = /^(\d+)\s*([smhd])?$/i.exec(trimmed);
  if (!match) return fallbackSeconds;
  const n = parseInt(match[1], 10);
  const unit = (match[2] || 's').toLowerCase();
  const mult =
    unit === 's'
      ? 1
      : unit === 'm'
        ? 60
        : unit === 'h'
          ? 60 * 60
          : 24 * 60 * 60;
  return n * mult;
}

/** Access-token lifetime in seconds. Default: 8 hours. */
export const DEFAULT_ACCESS_TOKEN_SECONDS = 8 * 60 * 60;

/** Refresh-token lifetime in seconds. Default: 7 days. */
export const DEFAULT_REFRESH_TOKEN_SECONDS = 7 * 24 * 60 * 60;
