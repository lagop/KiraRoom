/**
 * The deactivate-location confirmation names the appointments still to come.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/location-deactivation.spec.ts
 */
import { deactivationNotice } from "./location-deactivation";

let pass = 0;
let fail = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}\n      expected: ${JSON.stringify(expected)}\n      actual:   ${JSON.stringify(actual)}`);
  }
}

check("no upcoming appointments", deactivationNotice(0), { key: "multiLocation.deactivate.noUpcoming" });
check("one", deactivationNotice(1), { key: "multiLocation.deactivate.upcomingOne" });
check("several, with the count", deactivationNotice(12), {
  key: "multiLocation.deactivate.upcomingMany",
  params: { count: 12 },
});
check("count not available: no notice, the dialog still asks", deactivationNotice(null), null);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
