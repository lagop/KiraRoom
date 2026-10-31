/**
 * The new-appointment drawer's suggested times (slot-suggestions.ts). Run via:
 *
 *   cd packages/frontend && npx ts-node --project tsconfig.test.json \
 *     --transpile-only app/dashboard/appointments/components/slot-suggestions.spec.ts
 */

import * as fs from "fs";
import * as path from "path";
import {
  AFTERNOON_FROM,
  buildSlotSuggestions,
  candidateProfessionals,
  freeTimes,
  planSlotSearch,
  suits,
  type TimePreference,
} from "./slot-suggestions";

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
  check(label, actual, true);
}

const base: TimePreference = {
  type: "next_available",
  morningPreferred: false,
  afternoonPreferred: false,
  specificDate: "",
  specificTimePeriod: "",
};
const today = "2026-03-30"; // a Monday; the week crosses into April
const allDay = { from: 0, to: 24 * 60 };

// ----- planSlotSearch -----

console.log("\n[planSlotSearch]");
check("next available: a week from today, all day", planSlotSearch(base, today), {
  days: ["2026-03-30", "2026-03-31", "2026-04-01", "2026-04-02", "2026-04-03", "2026-04-04", "2026-04-05"],
  ...allDay,
});
check("today in the morning: before 14:00", planSlotSearch({ ...base, type: "today_morning" }, today), {
  days: [today],
  from: 0,
  to: AFTERNOON_FROM,
});
check("today in the afternoon: from 14:00", planSlotSearch({ ...base, type: "today_afternoon" }, today), {
  days: [today],
  from: 14 * 60,
  to: 24 * 60,
});
check(
  "flexible, mornings only",
  planSlotSearch({ ...base, type: "flexible", morningPreferred: true }, today, 2),
  { days: ["2026-03-30", "2026-03-31"], from: 0, to: AFTERNOON_FROM },
);
check(
  "flexible, afternoons only",
  planSlotSearch({ ...base, type: "flexible", afternoonPreferred: true }, today, 1),
  { days: [today], from: AFTERNOON_FROM, to: 24 * 60 },
);
check(
  "flexible, both ticked is any time",
  planSlotSearch({ ...base, type: "flexible", morningPreferred: true, afternoonPreferred: true }, today, 1),
  { days: [today], ...allDay },
);
check(
  "flexible, none ticked is any time",
  planSlotSearch({ ...base, type: "flexible" }, today, 1),
  { days: [today], ...allDay },
);
check("a specific day still needs its time of day", planSlotSearch({ ...base, type: "specific", specificDate: "2026-04-10" }, today), null);
check("a specific day needs the day", planSlotSearch({ ...base, type: "specific", specificTimePeriod: "morning" }, today), null);
check(
  "a specific morning",
  planSlotSearch({ ...base, type: "specific", specificDate: "2026-04-10", specificTimePeriod: "morning" }, today),
  { days: ["2026-04-10"], from: 0, to: AFTERNOON_FROM },
);
check(
  "a specific afternoon",
  planSlotSearch({ ...base, type: "specific", specificDate: "2026-04-10", specificTimePeriod: "evening" }, today),
  { days: ["2026-04-10"], from: AFTERNOON_FROM, to: 24 * 60 },
);
check(
  "a specific hour: the slots inside it",
  planSlotSearch({ ...base, type: "specific", specificDate: "2026-04-10", specificTimePeriod: "16:00" }, today),
  { days: ["2026-04-10"], from: 16 * 60, to: 17 * 60 },
);
check(
  "nonsense for the time of day",
  planSlotSearch({ ...base, type: "specific", specificDate: "2026-04-10", specificTimePeriod: "soon" }, today),
  null,
);

// ----- freeTimes / suits -----

console.log("\n[freeTimes]");
check(
  "only the free ones",
  freeTimes([{ time: "09:00", isAvailable: true }, { time: "09:30", isAvailable: false }, { time: "10:00" }]),
  ["09:00", "10:00"],
);
check("nothing from nothing", freeTimes(undefined), []);

console.log("\n[suits]");
const morning = { days: [today], from: 0, to: AFTERNOON_FROM };
const now = { day: today, minutes: 10 * 60 + 15 };
checkTrue("later today, in the morning", suits("11:00", today, morning, now));
checkTrue("not a time already gone today", !suits("10:00", today, morning, now));
checkTrue("the minute itself still counts", suits("10:15", today, morning, now));
checkTrue("any time tomorrow", suits("09:00", "2026-03-31", morning, now));
checkTrue("not a day already gone", !suits("12:00", "2026-03-29", morning, now));
checkTrue("not 14:00 for the morning", !suits("14:00", "2026-03-31", morning, now));
checkTrue("not a malformed time", !suits("later", "2026-03-31", morning, now));

// ----- buildSlotSuggestions -----

console.log("\n[buildSlotSuggestions]");
const suggestions = buildSlotSuggestions({
  day: "2026-03-31",
  search: { days: ["2026-03-31"], ...allDay },
  now,
  durationMinutes: 45,
  byProfessional: [
    { professionalId: "p-ana", name: "Ana", times: ["10:00", "09:00"] },
    { professionalId: "p-eva", name: "Eva", times: ["09:00", "09:30"] },
  ],
});
check("each time once, sorted", suggestions.map((s) => s.startTime), ["09:00", "09:30", "10:00"]);
check("the first professional free then", suggestions.map((s) => s.professionalName), ["Ana", "Eva", "Ana"]);
check("the end from the visit's length", suggestions[0].endTime, "09:45");
check("ids are unique", new Set(suggestions.map((s) => s.id)).size, suggestions.length);
const anyone = buildSlotSuggestions({
  day: today,
  search: morning,
  now,
  durationMinutes: 30,
  byProfessional: [{ professionalId: "", name: "", times: ["09:30", "10:30", "13:30", "14:00"] }],
  max: 1,
});
check(
  "asked for anyone: no professional, gone and afternoon times left out, capped",
  anyone,
  [{ id: "2026-03-30T10:30", date: today, startTime: "10:30", endTime: "11:00" }],
);

// ----- candidateProfessionals -----

console.log("\n[candidateProfessionals]");
const team = [
  { id: "p-ana", services: [{ serviceId: "cut" }] },
  { id: "p-eva", services: [{ serviceId: "dye" }] },
  { id: "p-leo" },
];
check("the one chosen", candidateProfessionals(team, "cut", "p-eva").map((p) => p.id), ["p-eva"]);
check("those who offer it", candidateProfessionals(team, "cut").map((p) => p.id), ["p-ana"]);
check("everyone when nobody is linked to it", candidateProfessionals(team, "nails").map((p) => p.id), ["p-ana", "p-eva", "p-leo"]);

// ----- The old scheduler is gone -----

console.log("\n[the drawer asks the server]");
const hook = fs.readFileSync(
  path.join(__dirname, "appointment-drawer", "hooks", "useAppointmentSuggestions.ts"),
  "utf8",
);
checkTrue("the suggestions come from the server's free slots", hook.includes("getAvailableSlots("));
checkTrue("not from the old scheduler", !hook.includes("appointment-scheduler"));
checkTrue(
  "the old scheduler files are deleted",
  ["appointment-scheduler.ts", "appointment-scheduler-simple.ts", "appointment-scheduler.utils.ts"].every(
    (f) => !fs.existsSync(path.join(__dirname, "..", "..", "..", "..", "lib", f)),
  ),
);

// ----- Summary -----

console.log("\n=== Summary ===");
console.log(`Pass: ${pass}, Fail: ${fail}`);
if (fail > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(f);
  process.exit(1);
} else {
  console.log("✓ All slot-suggestions tests passed.");
}
