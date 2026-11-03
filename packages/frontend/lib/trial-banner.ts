/**
 * D25: the trial banner across the dashboard. Only the owner sees it (she is
 * the one who can choose a plan in Facturación), only in the last 7 days of
 * the trial, never once she has already subscribed during the trial, and
 * never before the server has confirmed the status. She can hide it for the
 * rest of the day; it comes back the next morning.
 */

export const TRIAL_BANNER_DAYS = 7;
export const TRIAL_BANNER_DISMISS_KEY = "kr.trialBanner.dismissedOn";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface TrialBannerInput {
  role: string | null | undefined;
  confirmed: boolean;
  inTrial: boolean;
  trialEnd: string | null;
  /** A paid subscription already exists (subscribed during the trial). */
  subscribed: boolean;
  /** The local day the banner was hidden on (YYYY-MM-DD), if any. */
  dismissedOn: string | null;
  now: Date;
}

/** The viewer's local day, the unit the banner is hidden for. */
export function localDayKey(now: Date): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, "0");
  const d = String(now.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** Whole days left in the trial, rounded up (a few hours left is 1 day). */
export function trialDaysLeft(trialEnd: string, now: Date): number {
  const ms = new Date(trialEnd).getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / DAY_MS));
}

/** Days left to show in the banner, or null when it is not shown. */
export function trialBannerDays(input: TrialBannerInput): number | null {
  if (input.role !== "owner") return null;
  if (!input.confirmed || !input.inTrial || !input.trialEnd || input.subscribed) return null;
  const days = trialDaysLeft(input.trialEnd, input.now);
  if (days < 1 || days > TRIAL_BANNER_DAYS) return null;
  if (input.dismissedOn === localDayKey(input.now)) return null;
  return days;
}
