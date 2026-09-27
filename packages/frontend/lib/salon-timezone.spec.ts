/**
 * Hand-rolled Node test runner, matching the style of the other frontend
 * specs. Run via:
 *
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only lib/salon-timezone.spec.ts
 *
 * A salon could not set its own timezone.
 *
 * The dashboard settings screen read `tenant.timezone` and sent it when it
 * changed, but had **no control that changed it**. Four selectors existed
 * across the app and three of them omitted `Atlantic/Canary`:
 *
 *   dashboard/settings          no control at all
 *   saas/tenants/[id]/edit      8 hardcoded zones, no Canarias
 *   saas/tenants/new            the same 8, duplicated
 *   accept-invite/[token]       9 zones, the only one WITH Canarias
 *
 * So a salon that signed up stayed on Europe/Madrid for good. In the Canary
 * Islands that is every appointment an hour off, for ever, and WhatsApp
 * reminders at the wrong time — in the market the go-to-market plan
 * recommends starting with.
 *
 * One list now, in @kira/shared, used by all four. This spec guards the list
 * itself and that no file goes back to hardcoding zones.
 */

import * as fs from "fs";
import * as path from "path";
import {
  SALON_TIMEZONES,
  DEFAULT_SALON_TIMEZONE,
  isKnownSalonTimezone,
  salonTimezoneLabel,
} from "@kira/shared";

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

console.log("\n=== every Spanish territory is offered ===");

const values = SALON_TIMEZONES.map((t) => t.value);

// The bug: this one was missing from three of the four selectors.
check("Canarias", values.includes("Atlantic/Canary"), true);
check("Península y Baleares", values.includes("Europe/Madrid"), true);
// Ceuta and Melilla really are Africa/Ceuta, even at Madrid's offset.
check("Ceuta y Melilla", values.includes("Africa/Ceuta"), true);

console.log("\n=== the list is usable as a selector ===");

check("no duplicate values", values.length, new Set(values).size);
check("every entry has a label", SALON_TIMEZONES.every((t) => t.label.length > 0), true);
check(
  "labels name the territory, not the identifier",
  SALON_TIMEZONES.every((t) => !t.label.includes("/")),
  true,
);
check("the default is on the list", values.includes(DEFAULT_SALON_TIMEZONE), true);
check("Spain comes first", SALON_TIMEZONES[0].value, "Europe/Madrid");

console.log("\n=== the expansion markets in the plan are covered ===");

check("Portugal", values.includes("Europe/Lisbon"), true);
check("Italia", values.includes("Europe/Rome"), true);
check("México", values.includes("America/Mexico_City"), true);

console.log("\n=== helpers ===");

check("a known zone is recognised", isKnownSalonTimezone("Atlantic/Canary"), true);
check("an unknown one is not", isKnownSalonTimezone("Mars/Olympus_Mons"), false);
check("a non-string is not", isKnownSalonTimezone(42), false);
check("a label resolves", salonTimezoneLabel("Atlantic/Canary"), "España — Canarias");
// A tenant may hold a zone the list dropped: America/Buenos_Aires was offered
// by the old console selector and is a deprecated alias. The label must not
// come back empty, or the selector would render a blank option.
check(
  "an unlisted zone falls back to its identifier",
  salonTimezoneLabel("America/Buenos_Aires"),
  "America/Buenos_Aires",
);

console.log("\n=== no selector hardcodes zones any more ===");

const APP = path.resolve(__dirname, "..", "app");
const offenders: string[] = [];
(function walk(dir: string): void {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(p);
      continue;
    }
    if (!entry.name.endsWith(".tsx")) continue;
    const src = fs.readFileSync(p, "utf8");
    // An <option> whose value is a tz identifier is the pattern that drifted.
    const re = /<option\s+value="[A-Za-z]+\/[A-Za-z_/]+"/g;
    const hits = src.match(re);
    if (hits) offenders.push(path.relative(APP, p) + ": " + hits.join(", "));
  }
})(APP);

check("no <option> carries a hardcoded timezone", offenders, []);

console.log("\n=== Summary ===");
console.log(`Pass: ${pass}, Fail: ${fail}`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(f);
  process.exit(1);
} else {
  console.log("✓ All salon-timezone tests passed.");
}
