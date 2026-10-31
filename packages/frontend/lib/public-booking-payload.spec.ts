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
 *
 * Further down: the date, slot and message helpers those screens share
 * (lib/public-booking.ts).
 */

import * as fs from "fs";
import * as path from "path";
import {
  bookingDateFromQuery,
  bookingErrorMessage,
  compareAppointmentsAsc,
  formatBookingDate,
  isClosedDay,
  isOfferedTime,
  localDateString,
  localTomorrow,
  privacyPolicyUrl,
  slotsState,
  weekdayKey,
} from "./public-booking";

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

// ---------------------------------------------------------------------------
// Dates, closed days, slots and messages (lib/public-booking.ts)
// ---------------------------------------------------------------------------

console.log("\n=== links keep their day (?date=) ===");

// The page tested ?date= against /^d{4}-d{2}-d{2}$/ -- no backslashes -- so
// wait-list and rebooking links always lost their day.
check("a real date from a link is kept", bookingDateFromQuery("2026-11-03", "2026-10-31"), "2026-11-03");
check("today is kept", bookingDateFromQuery("2026-10-31", "2026-10-31"), "2026-10-31");
check("a past date is dropped", bookingDateFromQuery("2026-10-30", "2026-10-31"), "");
check("a non-date is dropped", bookingDateFromQuery("dddd-dd-dd", "2026-10-31"), "");
check("an impossible date is dropped", bookingDateFromQuery("2026-02-30", "2026-01-01"), "");
check("no date, no prefill", bookingDateFromQuery(null, "2026-10-31"), "");

const pageSource = fs.readFileSync(
  path.join(ROOT, "app/sites/[salonName]/salon-booking-page.tsx"),
  "utf8",
);
check(
  "the public page reads ?date= through bookingDateFromQuery",
  /bookingDateFromQuery\(q\.get\("date"\)\)/.test(pageSource),
  true,
);
check("the broken pattern is gone", pageSource.includes("/^d{4}-d{2}-d{2}$/.test("), false);

console.log("\n=== local calendar days, not UTC ===");

// 00:30 on 1 Nov in the runner's timezone: toISOString() would give
// 31 Oct anywhere east of Greenwich.
const justAfterMidnight = new Date(2026, 10, 1, 0, 30);
check("today is the local day", localDateString(justAfterMidnight), "2026-11-01");
check("tomorrow is the next local day", localTomorrow(justAfterMidnight), "2026-11-02");
check("tomorrow crosses the month", localTomorrow(new Date(2026, 9, 31, 23, 50)), "2026-11-01");
check("weekday from the date's own parts: 1 Nov 2026 is a Sunday", weekdayKey("2026-11-01"), "sunday");
check("2 Nov 2026 is a Monday", weekdayKey("2026-11-02"), "monday");
check("formatted in Spanish from its parts", formatBookingDate("2026-11-01"), "domingo, 1 de noviembre de 2026");
check("a stored ISO date keeps its day", formatBookingDate("2026-11-02T00:00:00.000Z"), "lunes, 2 de noviembre de 2026");

console.log("\n=== closed days come from the salon's hours ===");

const weekdaysOnly = {
  monday: { openTime: "09:00", closeTime: "18:00" },
  tuesday: { openTime: "09:00", closeTime: "18:00" },
};
const openSundays = { ...weekdaysOnly, sunday: { openTime: "10:00", closeTime: "14:00" } };
check("a day the salon does not open is closed", isClosedDay("2026-11-01", weekdaysOnly), true);
check("a salon that opens on Sunday is open on Sunday", isClosedDay("2026-11-01", openSundays), false);
check("an open weekday is open", isClosedDay("2026-11-02", weekdaysOnly), false);
check("no hours recorded: no day is closed", isClosedDay("2026-11-01", {}), false);
check("no hours at all: no day is closed", isClosedDay("2026-11-01", undefined), false);
check("no screen refuses Sundays outright any more", /dayOfWeek === 0|salonClosedSunday/.test(pageSource), false);
const clientAreaSource = fs.readFileSync(
  path.join(ROOT, "app/sites/[salonName]/account/new-appointment/page.tsx"),
  "utf8",
);
check("nor the client area", /dayOfWeek === 0|cerrado los domingos/.test(clientAreaSource), false);

console.log("\n=== only an offered time can be sent ===");

const offered = [
  { time: "10:00", available: true },
  { time: "10:30", available: false },
];
check("a free offered time", isOfferedTime("10:00", offered), true);
check("a taken time", isOfferedTime("10:30", offered), false);
check("a time from another list", isOfferedTime("17:00", offered), false);
check("no time", isOfferedTime("", offered), false);
check("nothing loaded (inputs just changed)", isOfferedTime("10:00", []), false);

console.log("\n=== the time picker says the right thing ===");

const base = { serviceId: "s", professionalId: "p", date: "2026-11-02", loading: false, slots: offered, closed: false };
check("no service", slotsState({ ...base, serviceId: "" }), "select_service_first");
check("no professional", slotsState({ ...base, professionalId: "" }), "select_professional_first");
check("loading", slotsState({ ...base, loading: true }), "loading_slots");
check("slots to show", slotsState(base), "ready");
const allTaken = [{ time: "10:00", available: false }];
check("nothing free", slotsState({ ...base, slots: allTaken }), "no_slots");
check("nothing free on a closed day", slotsState({ ...base, slots: [], closed: true }), "closed_day");
check("a closed day with free slots still shows them", slotsState({ ...base, closed: true }), "ready");

const es = JSON.parse(fs.readFileSync(path.join(ROOT, "messages/es.json"), "utf8"));
const en = JSON.parse(fs.readFileSync(path.join(ROOT, "messages/en.json"), "utf8"));
for (const key of ["select_service_first", "select_professional_first", "loading_slots", "closed_day", "no_slots"]) {
  check(`bookingPublic.${key} exists in es and en`, [typeof es.bookingPublic[key], typeof en.bookingPublic[key]], ["string", "string"]);
}

console.log("\n=== server messages reach the client readable ===");

check(
  "NestJS's field path is dropped",
  bookingErrorMessage("clientInfo.Introduce un teléfono válido (al menos 9 cifras)"),
  "Introduce un teléfono válido (al menos 9 cifras)",
);
check(
  "several joined messages each lose it",
  bookingErrorMessage("clientInfo.Introduce un email válido. Elige una hora válida"),
  "Introduce un email válido. Elige una hora válida",
);
check("an array body is handled", bookingErrorMessage(["clientInfo.El teléfono es obligatorio"]), "El teléfono es obligatorio");
check("a plain message is untouched", bookingErrorMessage("Esa hora ya no está disponible"), "Esa hora ya no está disponible");
check("nothing gives nothing", bookingErrorMessage(undefined), "");

console.log("\n=== the client area lists by day and time ===");

const sorted = [
  { id: "c", scheduledDate: "2026-11-03T00:00:00.000Z", scheduledTime: "09:00" },
  { id: "b", scheduledDate: "2026-11-02T00:00:00.000Z", scheduledTime: "17:00" },
  { id: "a", scheduledDate: "2026-11-02T00:00:00.000Z", scheduledTime: "09:30" },
]
  .sort(compareAppointmentsAsc)
  .map((a) => a.id);
check("soonest first, the time breaking ties", sorted, ["a", "b", "c"]);

console.log("\n=== the privacy notice links where it exists ===");

check("absolute, on the app's host", privacyPolicyUrl("https://app.kiraroom.net"), "https://app.kiraroom.net/legal/privacy");
check("the page exists", fs.existsSync(path.join(ROOT, "app/legal/privacy/page.tsx")), true);
for (const rel of [...SCREENS, "app/embed/[token]/page.tsx"]) {
  const src = fs.readFileSync(path.join(ROOT, rel), "utf8");
  check(`${rel} shows the privacy notice`, src.includes("privacyPolicyUrl()"), true);
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
