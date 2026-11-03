/**
 * The trial banner (D25): owner only, last 7 days of the trial, not once she
 * has subscribed, hidden for the rest of the day when she closes it.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/trial-banner.spec.ts
 */
import { localDayKey, trialBannerDays, trialDaysLeft, type TrialBannerInput } from "./trial-banner";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, detail ?? "");
  }
}

const now = new Date(2026, 10, 3, 10, 0, 0); // 3 Nov 2026, 10:00 local
const inDays = (d: number, extraHours = 0) =>
  new Date(now.getTime() + d * 86400000 + extraHours * 3600000).toISOString();

const base: TrialBannerInput = {
  role: "owner",
  confirmed: true,
  inTrial: true,
  trialEnd: inDays(5),
  subscribed: false,
  dismissedOn: null,
  now,
};

check("the owner sees it with 5 days left", trialBannerDays(base) === 5, trialBannerDays(base));
check("7 days left is inside the window", trialBannerDays({ ...base, trialEnd: inDays(7) }) === 7);
check("8 days left is too early", trialBannerDays({ ...base, trialEnd: inDays(8) }) === null);
check("a few hours left counts as 1 day", trialBannerDays({ ...base, trialEnd: inDays(0, 3) }) === 1);
check("an admin does not see it", trialBannerDays({ ...base, role: "admin" }) === null);
check("a professional does not see it", trialBannerDays({ ...base, role: "staff" }) === null);
check("not before the role is read", trialBannerDays({ ...base, role: undefined }) === null);
check("not before the server confirms the status", trialBannerDays({ ...base, confirmed: false }) === null);
check("not outside the trial", trialBannerDays({ ...base, inTrial: false }) === null);
check("not once she subscribed during the trial", trialBannerDays({ ...base, subscribed: true }) === null);
check("hidden for the day she closed it", trialBannerDays({ ...base, dismissedOn: localDayKey(now) }) === null);
check(
  "back the next day",
  trialBannerDays({ ...base, dismissedOn: localDayKey(new Date(now.getTime() - 86400000)) }) === 5,
);
check("localDayKey is the local date", localDayKey(now) === "2026-11-03", localDayKey(now));
check("trialDaysLeft never goes negative", trialDaysLeft(inDays(-2), now) === 0);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
