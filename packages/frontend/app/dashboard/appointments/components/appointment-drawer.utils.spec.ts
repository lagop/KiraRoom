/**
 * Hand-rolled Node test runner matching the style of
 * `lib/appointment-scheduler.test.ts`. Run via:
 *
 *   cd packages/frontend && npx ts-node \
 *     app/dashboard/appointments/components/appointment-drawer.utils.spec.ts
 *
 * Asserts behavior of the pure helpers extracted from the
 * 4000-line `appointment-drawer.tsx` monolith.
 */

import {
  addMinutesToTime,
  calculateTotalDuration,
  formatDateString,
  formatDateTimeString,
  formatIsoDate,
  getProfessionalName,
  getStatusBadgeStyle,
  getTotalDuration,
  getTotalPrice,
  sumServiceDurations,
  transformAddons,
} from "./appointment-drawer.utils";

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

function checkTrue(label: string, actual: boolean): void {
  if (actual) {
    pass += 1;
    console.log(`  ✓ ${label}`);
  } else {
    fail += 1;
    const msg = `  ✗ ${label} (expected true)`;
    console.log(msg);
    failures.push(msg);
  }
}

// ----- addMinutesToTime -----

console.log("\n[addMinutesToTime]");
check("forward 30 min", addMinutesToTime("10:00", 30), "10:30");
check("across hour boundary", addMinutesToTime("10:45", 30), "11:15");
check("across midnight", addMinutesToTime("23:30", 60), "00:30");
check("zero minutes", addMinutesToTime("09:00", 0), "09:00");
check("wrap multiple days", addMinutesToTime("00:00", 1440), "00:00");
check("negative time wraps forward", addMinutesToTime("00:30", -60), "23:30");

// ----- formatDateString / formatDateTimeString -----

console.log("\n[formatDateString]");
const sample = "2026-03-17";
const formatted = formatDateString(sample);
// Locale-dependent: just check the date components are present.
checkTrue("contains weekday", /Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday/.test(formatted));
checkTrue("contains year", formatted.includes("2026"));
checkTrue("contains month name", /March|February|January|April|April|Apr/.test(formatted) || formatted.includes("March"));

console.log("\n[formatDateTimeString]");
const formattedDt = formatDateTimeString("2026-03-17T14:30:00Z");
checkTrue("contains year", formattedDt.includes("2026"));
checkTrue("contains hour", /\d{1,2}:\d{2}/.test(formattedDt));

// ----- formatIsoDate -----

console.log("\n[formatIsoDate]");
check("UTC ISO date", formatIsoDate(new Date("2026-03-17T12:00:00Z")), "2026-03-17");
check("different timezone still UTC ISO", formatIsoDate(new Date("2026-12-31T23:59:59Z")), "2026-12-31");

// ----- getTotalPrice -----

console.log("\n[getTotalPrice]");
const services = [
  { id: "s1", price: 30 },
  { id: "s2", price: 50 },
  { id: "s3", price: 25 },
  { id: "s4" }, // no price → contributes 0
];
check("empty selection with fallback", getTotalPrice([], services, "s1"), 30);
check("empty selection without fallback", getTotalPrice([], services), 0);
check("multi-service sum", getTotalPrice(
  [{ serviceId: "s1" }, { serviceId: "s2" }, { serviceId: "s4" }],
  services,
), 80);
check("unknown service id", getTotalPrice([{ serviceId: "x" }], services), 0);
check("string price coerces to number", getTotalPrice(
  [{ serviceId: "s1" }],
  [{ id: "s1", price: "30" as unknown as number }],
), 30);

// ----- getTotalDuration -----

console.log("\n[getTotalDuration]");
const durationServices = [
  { id: "s1", duration: 30 },
  { id: "s2", duration: 45 },
  { id: "s3", duration: 60 },
];
check("empty selection with fallback", getTotalDuration([], durationServices, "s2"), 45);
check("empty without fallback", getTotalDuration([], durationServices), 0);
check("all serial sums", getTotalDuration(
  [
    { serviceId: "s1", isParallel: false },
    { serviceId: "s2", isParallel: false },
    { serviceId: "s3", isParallel: false },
  ],
  durationServices,
), 135);
check("parallel takes max", getTotalDuration(
  [
    { serviceId: "s1", isParallel: true },
    { serviceId: "s2", isParallel: true },
    { serviceId: "s3", isParallel: true },
  ],
  durationServices,
), 60);
check("mixed parallel + serial", getTotalDuration(
  [
    { serviceId: "s1", isParallel: true },
    { serviceId: "s2", isParallel: false },
    { serviceId: "s3", isParallel: true },
  ],
  durationServices,
), Math.max(30, 60) + 45);
check("missing duration falls back to 0", getTotalDuration(
  [{ serviceId: "missing" }],
  durationServices,
), 0);

// ----- calculateTotalDuration (appointment shape) -----

console.log("\n[calculateTotalDuration]");
check("no multi-services → service + addons",
  calculateTotalDuration({
    service: { duration: 60 },
    addons: [{ duration: 10 }, { duration: 15 }],
  }),
  85);
check("all serial services",
  calculateTotalDuration({
    service: { duration: 30 },
    services: [
      { service: { duration: 30 }, isParallel: false },
      { service: { duration: 60 }, isParallel: false },
    ],
  }),
  90);
check("parallel takes max + addons",
  calculateTotalDuration({
    service: { duration: 30 },
    services: [
      { service: { duration: 60 }, isParallel: true },
      { service: { duration: 90 }, isParallel: true },
      { service: { duration: 30 }, isParallel: false },
    ],
    addons: [{ duration: 5 }],
  }),
  90 + 30 + 5);
check("handles null addons", calculateTotalDuration({ service: { duration: 30 } }), 30);
check("handles undefined services", calculateTotalDuration({ service: { duration: 30 }, services: undefined }), 30);

// ----- transformAddons -----

console.log("\n[transformAddons]");
check("null returns empty", transformAddons(null, []), []);
check("undefined returns empty", transformAddons(undefined, []), []);
check("empty array", transformAddons([], []), []);
const catalog = [
  { id: "a1", name: "Shampoo", price: 8, duration: 5 },
  { id: "a2", name: "Mask", price: 15, duration: 10 },
];
check("array of {addonId, quantity}", transformAddons(
  [{ addonId: "a1", quantity: 2 }, { addonId: "a2", quantity: 1 }],
  catalog,
), [
  { id: "a1", name: "Shampoo", quantity: 2, price: 8, duration: 5 },
  { id: "a2", name: "Mask", quantity: 1, price: 15, duration: 10 },
]);
check("object with .set", transformAddons(
  { set: [{ addonId: "a1", quantity: 3 }] },
  catalog,
), [{ id: "a1", name: "Shampoo", quantity: 3, price: 8, duration: 5 }]);
check("legacy object {id: quantity}", transformAddons(
  { a1: 2, a2: 1 },
  catalog,
), [
  { id: "a1", name: "Shampoo", quantity: 2, price: 8, duration: 5 },
  { id: "a2", name: "Mask", quantity: 1, price: 15, duration: 10 },
]);
check("filters unresolvable addonIds", transformAddons(
  [{ addonId: "ghost", quantity: 1 }, { addonId: "a1", quantity: 2 }],
  catalog,
), [{ id: "a1", name: "Shampoo", quantity: 2, price: 8, duration: 5 }]);
check("supports serviceId alias", transformAddons(
  [{ serviceId: "a1", quantity: 1 }],
  catalog,
), [{ id: "a1", name: "Shampoo", quantity: 1, price: 8, duration: 5 }]);
check("string id coerces", transformAddons(
  [{ addonId: "1" }],
  [{ id: 1, name: "Foo", price: 5, duration: 1 }] as any,
), [{ id: "1", name: "Foo", quantity: undefined, price: 5, duration: 1 }]);

// ----- getProfessionalName -----

console.log("\n[getProfessionalName]");
const pros = [
  { id: "p1", firstName: "María", lastName: "García" },
  { id: "p2", firstName: "John", lastName: "Doe" },
];
check("returns full name", getProfessionalName("p1", pros), "María García");
check("unknown id → Staff", getProfessionalName("ghost", pros), "Staff");
check("undefined → Staff", getProfessionalName(undefined, pros), "Staff");
check("empty professionals → Staff", getProfessionalName("p1", []), "Staff");

// ----- getStatusBadgeStyle -----

console.log("\n[getStatusBadgeStyle]");
check("confirmed style", getStatusBadgeStyle("confirmed").label, "Confirmed");
check("pending style", getStatusBadgeStyle("pending").bg, "bg-yellow-50");
check("cancelled style", getStatusBadgeStyle("cancelled").border, "border-red-200");
check("in_progress style", getStatusBadgeStyle("in_progress").label, "In Progress");
check("completed style", getStatusBadgeStyle("completed").text, "text-blue-700");
check("unknown status falls back to gray", getStatusBadgeStyle("future_status").label, "future_status");
check("unknown status uses gray bg", getStatusBadgeStyle("future_status").bg, "bg-gray-50");

// ----- sumServiceDurations -----

console.log("\n[sumServiceDurations]");
check("sums all durations", sumServiceDurations(
  [{ serviceId: "s1" }, { serviceId: "s2" }],
  [{ id: "s1", duration: 30 }, { id: "s2", duration: 45 }],
), 75);
check("uses default when duration missing", sumServiceDurations(
  [{ serviceId: "s1" }],
  [{ id: "s1" }],
), 60);
check("custom default", sumServiceDurations(
  [{ serviceId: "s1" }],
  [{ id: "s1" }],
  120,
), 120);
check("empty selection", sumServiceDurations([], [{ id: "s1", duration: 30 }]), 0);

// ----- Summary -----

console.log("\n=== Summary ===");
console.log(`Pass: ${pass}, Fail: ${fail}`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(f);
  process.exit(1);
} else {
  console.log("✓ All appointment-drawer.utils tests passed.");
}