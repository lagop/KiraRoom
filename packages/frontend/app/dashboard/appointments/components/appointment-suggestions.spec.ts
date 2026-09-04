/**
 * Hand-rolled Node test runner matching the style of
 * `appointment-drawer.utils.spec.ts`. Run via:
 *
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only \
 *     app/dashboard/appointments/components/appointment-suggestions.spec.ts
 *
 * Validates the pure fallback-suggestion generator — the highest-risk
 * surface in the 4000-line appointment-drawer.tsx (no coverage before
 * this refactor).
 */

import {
  generateFallbackSuggestions,
} from "./appointment-suggestions";

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

// ----- fixtures -----

const services = [
  { id: "s1", name: "Corte", duration: 30 },
  { id: "s2", name: "Tinte", duration: 90 },
];

const professionals = [
  { id: "p1", firstName: "María", lastName: "García" },
  { id: "p2", firstName: "John", lastName: "Doe" },
];

const baseSelected = [
  { serviceId: "s1", professionalId: "p1" },
  { serviceId: "s2", professionalId: undefined },
];

// ----- shape -----

console.log("\n[shape]");

{
  const out = generateFallbackSuggestions({
    preferenceType: "next_available",
    selectedServices: baseSelected,
    services,
    professionals,
    // Pin a fixed clock so the output is deterministic regardless of
    // the test machine's local timezone.
    now: new Date("2026-03-17T10:00:00Z"),
  });
  checkTrue("returns an array", Array.isArray(out));
  checkTrue("at most 4 suggestions", out.length <= 4);
  check("every suggestion has id", out.every((s) => typeof s.id === "string"), true);
  check(
    "every suggestion has timeline",
    out.every((s) => Array.isArray(s.timeline) && s.timeline.length > 0),
    true,
  );
  check(
    "every timeline entry has type/service/professional/start/end",
    out.every((s) =>
      s.timeline.every(
        (tl) =>
          typeof tl.startTime === "string" &&
          typeof tl.endTime === "string" &&
          typeof tl.service === "string" &&
          typeof tl.professional === "string",
      ),
    ),
    true,
  );
  check("startTime/endTime are HH:MM", out.every((s) => /^\d{2}:\d{2}$/.test(s.startTime) && /^\d{2}:\d{2}$/.test(s.endTime)), true);
}

// ----- next_available -----

console.log("\n[next_available]");
{
  const out = generateFallbackSuggestions({
    preferenceType: "next_available",
    selectedServices: baseSelected,
    services,
    professionals,
    now: new Date("2026-03-17T10:00:00Z"),
  });
  check("returns 4 suggestions", out.length, 4);
  check(
    "first slot is recommended",
    out[0].recommended && !out[1].recommended && !out[2].recommended,
    true,
  );
  check(
    "ids follow fallback_next_N pattern",
    out.map((s) => s.id),
    ["fallback_next_1", "fallback_next_2", "fallback_next_3", "fallback_next_4"],
  );
  check("first startTime is 10:00", out[0].startTime, "10:00");
  check("last startTime is 15:00", out[3].startTime, "15:00");
  check(
    "date is tomorrow's ISO",
    out[0].date,
    "2026-03-18",
  );
  // Total duration = 30 + 90 = 120 minutes.
  check("endTime = startTime + 120 min", out[0].endTime, "12:00");
}

// ----- today_morning -----

console.log("\n[today_morning]");

{
  // Before noon: uses today.
  const morningNow = new Date("2026-03-17T09:00:00Z");
  const outMorning = generateFallbackSuggestions({
    preferenceType: "today_morning",
    selectedServices: baseSelected,
    services,
    professionals,
    now: morningNow,
  });
  check("returns 4 suggestions", outMorning.length, 4);
  check("first starts at 09:00 (earliest morning slot)", outMorning[0].startTime, "09:00");
  check("uses today's date (before noon)", outMorning[0].date, "2026-03-17");
}

{
  // After noon: rolls to tomorrow.
  const afternoonNow = new Date("2026-03-17T15:00:00Z");
  const outAfternoon = generateFallbackSuggestions({
    preferenceType: "today_morning",
    selectedServices: baseSelected,
    services,
    professionals,
    now: afternoonNow,
  });
  check("rolls to tomorrow (after noon)", outAfternoon[0].date, "2026-03-18");
}

// ----- today_afternoon -----

console.log("\n[today_afternoon]");

{
  const beforeFour = new Date("2026-03-17T10:00:00Z");
  const out1 = generateFallbackSuggestions({
    preferenceType: "today_afternoon",
    selectedServices: baseSelected,
    services,
    professionals,
    now: beforeFour,
  });
  check("uses today before 16:00", out1[0].date, "2026-03-17");
  check("first afternoon slot is 14:00", out1[0].startTime, "14:00");

  const afterFour = new Date("2026-03-17T17:00:00Z");
  const out2 = generateFallbackSuggestions({
    preferenceType: "today_afternoon",
    selectedServices: baseSelected,
    services,
    professionals,
    now: afterFour,
  });
  check("rolls to tomorrow after 16:00", out2[0].date, "2026-03-18");
}

// ----- flexible -----

console.log("\n[flexible]");
{
  const out = generateFallbackSuggestions({
    preferenceType: "flexible",
    selectedServices: baseSelected,
    services,
    professionals,
    now: new Date("2026-03-17T10:00:00Z"),
  });
  check("returns 4 suggestions", out.length, 4);
  check(
    "ids follow fallback_flexible_N",
    out.map((s) => s.id),
    [
      "fallback_flexible_1",
      "fallback_flexible_2",
      "fallback_flexible_3",
      "fallback_flexible_4",
    ],
  );
  check("uses tomorrow's date", out[0].date, "2026-03-18");
}

// ----- unknown / default -----

console.log("\n[unknown preference → generic]");
{
  const out = generateFallbackSuggestions({
    preferenceType: "made_up_preference",
    selectedServices: baseSelected,
    services,
    professionals,
    now: new Date("2026-03-17T10:00:00Z"),
  });
  check("returns 3 suggestions (default slice)", out.length, 3);
  check(
    "ids follow fallback_generic_N",
    out.map((s) => s.id),
    ["fallback_generic_1", "fallback_generic_2", "fallback_generic_3"],
  );
}

// ----- localization -----

console.log("\n[labels]");
{
  const out = generateFallbackSuggestions({
    preferenceType: "today_morning",
    selectedServices: baseSelected,
    services,
    professionals,
    now: new Date("2026-03-17T15:00:00Z"), // rolls to tomorrow
    labels: { today: "Hoy", tomorrow: "Mañana" },
  });
  check(
    "title uses 'Mañana' label after noon",
    out[0].title,
    "Mañana Morning",
  );
}

// ----- service with no professional -----

console.log("\n[missing professional id]");
{
  const out = generateFallbackSuggestions({
    preferenceType: "next_available",
    selectedServices: [{ serviceId: "s1", professionalId: undefined }],
    services,
    professionals: [], // no pros at all
    now: new Date("2026-03-17T10:00:00Z"),
  });
  check("returns suggestions even with no professionals", out.length, 4);
  check(
    "timeline uses 'Staff' fallback name",
    out[0].timeline[0].professional,
    "Staff",
  );
}

// ----- timeline uses service name + duration -----

console.log("\n[timeline wiring]");
{
  const out = generateFallbackSuggestions({
    preferenceType: "next_available",
    selectedServices: baseSelected,
    services,
    professionals,
    now: new Date("2026-03-17T10:00:00Z"),
  });
  const timeline = out[0].timeline;
  check("2 timeline entries for 2 selected services", timeline.length, 2);
  check(
    "first timeline entry is service s1",
    timeline[0].service,
    "Corte",
  );
  check(
    "first timeline entry starts at slot startTime",
    timeline[0].startTime,
    out[0].startTime,
  );
  check(
    "first timeline entry ends at startTime + 30 min",
    timeline[0].endTime,
    "10:30",
  );
  check(
    "first timeline entry uses professional p1",
    timeline[0].professional,
    "María García",
  );
  check(
    "second timeline entry uses 'Staff' fallback (no proId)",
    timeline[1].professional,
    "Staff",
  );
  check(
    "second timeline entry is service s2 (Tinte)",
    timeline[1].service,
    "Tinte",
  );
  check(
    "second timeline entry ends at startTime + 90 min",
    timeline[1].endTime,
    "11:30",
  );
}

// ----- capped at 4 even if the array was sliced -----

console.log("\n[cap at 4]");
{
  // Force a slice by feeding extra selectedServices that all match
  // (default branch already does this — it has 3). The cap is on
  // next_available (4) and flexible (4) and others. Validate the cap
  // explicitly:
  const out = generateFallbackSuggestions({
    preferenceType: "next_available",
    selectedServices: baseSelected,
    services,
    professionals,
    now: new Date("2026-03-17T10:00:00Z"),
  });
  checkTrue("never returns more than 4", out.length <= 4);
}

// ----- Summary -----

console.log("\n=== Summary ===");
console.log(`Pass: ${pass}, Fail: ${fail}`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(f);
  process.exit(1);
} else {
  console.log("✓ All appointment-suggestions tests passed.");
}