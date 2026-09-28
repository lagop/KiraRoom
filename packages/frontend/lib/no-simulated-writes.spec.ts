/**
 * Hand-rolled Node test runner, matching the style of the other frontend
 * specs. Run via:
 *
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only lib/no-simulated-writes.spec.ts
 *
 * No screen may claim something was saved without having saved it.
 *
 * The public booking page did exactly that:
 *
 *     // TODO: Implement booking API endpoint
 *     console.log("Booking data:", appointmentData);
 *     // Simulate API call
 *     await new Promise((resolve) => setTimeout(resolve, 1500));
 *     toast({ title: t("bookingPublic.booking_confirmed") });
 *
 * It printed the payload to the browser console, waited 1500 ms so the button
 * looked busy, and said "Reserva confirmada". Verified against production: the
 * page reported success while the database held 0 appointments, 0 clients and
 * no `first_booking_received` event. A client would have left believing she had
 * an appointment the salon would never see.
 *
 * `POST /appointments` had been `@Public()` all along, and the service creates
 * the client from `clientInfo`. Only the call was missing.
 *
 * Writing this spec then found the same pattern on four more screens, so it is
 * a baseline rather than a clean sweep: the list below is what is known, and
 * the spec fails when something NEW joins it or when an entry becomes stale.
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

/**
 * Screens that still report success for something that does not happen, each
 * with what it would take to finish it. Remove an entry when it is fixed — the
 * "no stale entries" case below fails if you forget.
 *
 * Ordered by how much damage the lie does.
 */
const KNOWN_UNIMPLEMENTED: Record<string, string> = {
};

const APP = path.resolve(__dirname, "..", "app");

function sourceFiles(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  (function walk(dir: string): void {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(p);
        continue;
      }
      if (!entry.name.endsWith(".tsx") && !entry.name.endsWith(".ts")) continue;
      out.push([path.relative(APP, p).replace(/\\/g, "/"), fs.readFileSync(p, "utf8")]);
    }
  })(APP);
  return out;
}

const files = sourceFiles();
const known = Object.keys(KNOWN_UNIMPLEMENTED);

console.log(`\n=== scanning ${files.length} files under app/ ===`);

console.log("\n=== nothing fakes a round trip ===");

// A comment saying so. This is the clearest tell and there are none left.
check(
  "no 'Simulate API call'",
  files.filter(([, src]) => /\/\/\s*Simulate API call/i.test(src)).map(([f]) => f),
  [],
);

// An awaited delay of a second or more exists only to make a stub feel like a
// request. Shorter waits are excluded on purpose: the POS pauses 500 ms after a
// real checkout before refetching, which is a UI choice, not a pretence.
const fakeDelay = files
  .filter(([, src]) =>
    /await new Promise\((?:\w+|\(\w+\)) =>\s*setTimeout\(\w+,\s*(?:[1-9]\d{3,})\)\)/.test(src),
  )
  .map(([f]) => f);
check("no awaited delay of 1s or more standing in for a request", fakeDelay, []);

console.log("\n=== no NEW unimplemented write path ===");

const todoEndpoints = files
  .filter(([, src]) => /TODO:\s*Implement\s+.*(API|endpoint)/i.test(src))
  .map(([f]) => f);

// The point of the baseline: a screen that joins this set has to be a
// deliberate decision, not something nobody noticed.
check(
  "no file outside the known list",
  todoEndpoints.filter((f) => !known.includes(f)),
  [],
);

console.log("\n=== the baseline stays honest ===");

check(
  "no stale entry (all listed files still have the TODO)",
  known.filter((f) => !todoEndpoints.includes(f)),
  [],
);
check(
  "every entry says what finishing it needs",
  Object.values(KNOWN_UNIMPLEMENTED).filter((why) => why.length < 40),
  [],
);

console.log("\n=== the public booking page really posts ===");

const booking = files.find(([f]) => f === "sites/[salonName]/page.tsx");
check("the page is still where expected", Boolean(booking), true);

if (booking) {
  const src = booking[1];
  check("it calls createAppointment", src.includes("apiClient.createAppointment("), true);
  check("it sends the tenant", src.includes("tenantId: salonData.id"), true);
  check("it sends scheduledDate", src.includes("scheduledDate: bookingData.date"), true);
  check("it sends scheduledTime", src.includes("scheduledTime: bookingData.time"), true);

  // The confirmation has to come after the await, or it is a lie again.
  const callAt = src.indexOf("apiClient.createAppointment(");
  const confirmAt = src.indexOf('t("bookingPublic.booking_confirmed")');
  check("the confirmation comes after the call", callAt > -1 && callAt < confirmAt, true);

  // And the times have to come from the server.
  check("it asks the server for slots", src.includes("apiClient.getAvailableSlots("), true);
  check("no mock slot loop survives", src.includes("mockSlots"), false);
}

console.log("\n=== Summary ===");
console.log(`Pass: ${pass}, Fail: ${fail}`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(f);
  process.exit(1);
} else {
  console.log("✓ All no-simulated-writes tests passed.");
}

export {};
