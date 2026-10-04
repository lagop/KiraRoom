/**
 * Hand-rolled Node test runner, matching the style of the other frontend
 * specs. Run via:
 *
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only lib/account-settings.spec.ts
 *
 * The salon site's account settings said "Configuración guardada" while
 * keeping the language, the time format and "ofertas por email" in
 * localStorage, and a first block of channel toggles changed nothing that
 * was ever sent. The page now sends every setting to the server and says
 * "guardado" only after it answered. These are the helpers it relies on,
 * plus a check that the page no longer stores settings in the browser.
 */

import * as fs from "fs";
import * as path from "path";
import {
  channelEnabled,
  emailChangeNeedsPassword,
  NOTIFICATION_TYPES,
  profileChanges,
  samePrefs,
  setChannel,
} from "./account-settings";

let pass = 0;
let fail = 0;
const failures: string[] = [];

function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    const msg = `  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`;
    console.log(msg);
    failures.push(msg);
  }
}

console.log("account settings");

const prefs = { appointment_confirmed: { email: true, sms: false }, payment_failed: { sms: true } };
check("a channel is on when a type uses it", channelEnabled(prefs, "email"), true);
check("types the page does not show do not count", channelEnabled(prefs, "sms"), false);

const off = setChannel(prefs, "email", false);
check("turning a channel off reaches every type", NOTIFICATION_TYPES.every((t) => off[t.key].email === false), true);
check("other channels are kept", off.appointment_confirmed.sms, false);
check("types the page does not show are kept as they were", off.payment_failed, { sms: true });
check("a change is a change", samePrefs(prefs, off), false);
check("no change is no change", samePrefs(prefs, { ...prefs }), true);

const saved = { firstName: "Ana", lastName: "Pérez", email: "ana@example.test", phone: "" };
check("only changed fields are sent, trimmed", profileChanges(saved, { ...saved, phone: " 600 000 000 " }), {
  phone: "600 000 000",
});
check("an email change asks for the password", emailChangeNeedsPassword(saved, { ...saved, email: "eva@example.test" }), true);
check("the same email does not", emailChangeNeedsPassword(saved, { ...saved, email: " ana@example.test " }), false);

const page = fs.readFileSync(
  path.join(__dirname, "..", "app", "sites", "[salonName]", "account", "settings", "page.tsx"),
  "utf8",
);
check("the settings page keeps nothing in localStorage but the signed-in user", /localStorage\.setItem\(\s*['"](?!user['"])/.test(page), false);
check("the settings page no longer reads the owner-only client route", page.includes("getClient("), false);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log(failures.join("\n"));
  process.exit(1);
}
