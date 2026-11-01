import { salonInstant } from "../appointments/salon-time";
import { salonDayAndTime } from "../appointments/reschedule-check";
import { safeTimeZone } from "../gift-cards/gift-card-expiry";

/**
 * Points expire after a time with no visit (owner decision 2026-11-02):
 * a paid visit or purchase renews the WHOLE balance
 * (LoyaltyMember.pointsRenewedAt), and a member with none for
 * `pointsExpirationDays` (365 by default) loses all of it, once, in a
 * nightly run in the salon's timezone (LoyaltyService.expireInactivePoints).
 */

export const DEFAULT_EXPIRATION_DAYS = 365;
/** The grace given when expiry is switched on or shortened. */
export const EXPIRY_GRACE_DAYS = 30;
/** From this hour of the salon's night the day's expiry runs. */
export const EXPIRY_LOCAL_HOUR = 3;

const DAY_MS = 24 * 60 * 60 * 1000;

/** "12 meses", "6 meses", "90 días": how the rule reads to a client. */
export function expiryPeriodText(days: number): string {
  if (days % 365 === 0) {
    const months = (days / 365) * 12;
    return `${months} meses`;
  }
  if (days % 30 === 0) {
    const months = days / 30;
    return months === 1 ? "1 mes" : `${months} meses`;
  }
  return days === 1 ? "1 día" : `${days} días`;
}

/** The rule as the receipt and the emails say it, or null when points never expire. */
export function expiryRuleText(days: number | null | undefined): string | null {
  if (!days || days <= 0) return null;
  return `Tus puntos caducan si pasan ${expiryPeriodText(days)} sin visitas`;
}

/**
 * The day's run for a salon: its calendar day (the ledger key: one expiry
 * per member and day) and the cutoff (a member whose last visit is before
 * it loses the balance). The cutoff is the start of the salon's day less
 * the period, so every hourly tick of the same day agrees on it. Null
 * before EXPIRY_LOCAL_HOUR in the salon: the night's run has not come yet.
 */
export function expiryRun(
  now: Date,
  timeZone: string | null | undefined,
  days: number,
): { day: string; cutoff: Date } | null {
  const tz = safeTimeZone(timeZone);
  const local = salonDayAndTime(now, tz);
  if (Number(local.time.slice(0, 2)) < EXPIRY_LOCAL_HOUR) return null;
  const startOfDay = salonInstant(local.day, "00:00", tz);
  return { day: local.day, cutoff: new Date(startOfDay.getTime() - days * DAY_MS) };
}

/**
 * When a salon switches expiry on or shortens it, members who were fine a
 * moment ago would lose their points in the next run: nothing expires for
 * EXPIRY_GRACE_DAYS. The later of the current grace and the new one.
 */
export function graceAfterChange(
  before: { pointsExpirationDays: number | null; pointsExpiryStartsAt: Date | null },
  nextDays: number | null | undefined,
  now: Date = new Date(),
): Date | null | undefined {
  if (nextDays === undefined) return undefined;
  const tighter =
    nextDays !== null && (before.pointsExpirationDays === null || nextDays < before.pointsExpirationDays);
  if (!tighter) return undefined;
  const grace = new Date(now.getTime() + EXPIRY_GRACE_DAYS * DAY_MS);
  return before.pointsExpiryStartsAt && before.pointsExpiryStartsAt > grace ? before.pointsExpiryStartsAt : grace;
}
