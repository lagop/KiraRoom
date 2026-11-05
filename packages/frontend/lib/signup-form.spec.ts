/**
 * Signup, login and email-confirmation helpers (lib/signup-form.ts).
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/signup-form.spec.ts
 */

import {
  EMAIL_NOTICE_SNOOZE_MS,
  salonWebPreview,
  showEmailVerificationNotice,
  turnstileSiteKey,
  withoutPlatformWords,
  suggestedWebAddress,
  typedWebAddress,
} from "./signup-form";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
    console.log(`  ✓ ${label}`);
  } else {
    fail++;
    console.log(`  ✗ ${label}`, { actual, expected });
  }
}

console.log("the web address shown under the salon name");
check("accents folded", salonWebPreview("Salón Lucía"), "salon-lucia.kiraroom.net");
check("nothing while the name is empty", salonWebPreview("   "), null);
check("platform words taken out", salonWebPreview("Soporte KiraRoom Ana"), "ana.kiraroom.net");
check("only platform words", salonWebPreview("KiraRoom Support"), "salon.kiraroom.net");
check("joined pieces taken out too", withoutPlatformWords("kirakiraroomroom-ana"), "ana");
check("Kira Room with a space", withoutPlatformWords("salon-kira-room"), "salon");

console.log("Turnstile is off without a site key");
check("unset", turnstileSiteKey(undefined), "");
check("blank", turnstileSiteKey("  "), "");
check("set", turnstileSiteKey(" 0x4AAA "), "0x4AAA");

console.log("the 'Confirma tu email' notice");
const now = new Date("2026-11-04T10:00:00Z");
const base = { role: "owner", verified: false, impersonated: false, dismissedAt: null, now };
check("an unconfirmed owner sees it", showEmailVerificationNotice(base), true);
check("not once confirmed", showEmailVerificationNotice({ ...base, verified: true }), false);
check("not while unknown", showEmailVerificationNotice({ ...base, verified: null }), false);
check("not for the team", showEmailVerificationNotice({ ...base, role: "staff" }), false);
check("not for support signed in as the salon", showEmailVerificationNotice({ ...base, impersonated: true }), false);
check(
  "hidden for a while after closing it",
  showEmailVerificationNotice({ ...base, dismissedAt: new Date(now.getTime() - 60_000).toISOString() }),
  false,
);
check(
  "back after the snooze",
  showEmailVerificationNotice({ ...base, dismissedAt: new Date(now.getTime() - EMAIL_NOTICE_SNOOZE_MS - 1).toISOString() }),
  true,
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
