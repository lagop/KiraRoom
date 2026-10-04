/**
 * Hand-rolled Node test runner, matching the style of the other frontend
 * specs. Run via:
 *
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only lib/public-booking-payload.spec.ts
 *
 * Every booking a signed-in client made on the salon site failed.
 *
 * POST /appointments is public, so it takes no clientId: an anonymous caller
 * must not be able to book as an existing client. It finds the client from
 * clientInfo instead (by email or phone, in that salon). The site page still
 * sent `{ clientId: currentUser.id }` for signed-in clients and no
 * clientInfo, and the backend answered 400 "clientInfo should not be null or
 * undefined".
 *
 * This checks that every screen calling the public createAppointment sends
 * clientInfo and never clientId.
 */

import * as fs from "fs";
import * as path from "path";

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

const ROOT = path.join(__dirname, "..");
const SCREENS = [
  "app/sites/[salonName]/salon-booking-page.tsx",
  "app/sites/[salonName]/account/new-appointment/page.tsx",
];

console.log("\n=== public bookings carry the client's details ===");

for (const rel of SCREENS) {
  const source = fs.readFileSync(path.join(ROOT, rel), "utf8");
  const call = source.indexOf("apiClient.createAppointment(");
  check(`${rel} calls createAppointment`, call >= 0, true);
  // The payload is built in the call or just above it.
  const around = source.slice(Math.max(0, call - 1500), call + 1500);
  check(`${rel} sends clientInfo`, /clientInfo\s*[:=]/.test(around), true);
  check(`${rel} does not send clientId`, /clientId\s*:/.test(around), false);
}

console.log("\n=== Summary ===");
console.log(`Pass: ${pass}, Fail: ${fail}`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(f);
  process.exit(1);
} else {
  console.log("✓ All public-booking-payload tests passed.");
}
