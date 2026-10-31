/**
 * The schedule editor's week, and its round trip to the API's workingHours.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/weekly-schedule.spec.ts
 *
 * Nothing edited a professional's hours after the onboarding wizard, and the
 * wizard knew one window per day. A split day (jornada partida) is two
 * entries for the same weekday; these cases pin how the editor reads, checks
 * and writes them.
 */
import {
  addShift,
  copyMondayToWeekdays,
  dayProblem,
  defaultSchedule,
  hasProblems,
  removeShift,
  scheduleFromWorkingHours,
  scheduleProblems,
  toggleDay,
  workingHoursFromSchedule,
  type WeeklySchedule,
} from "./weekly-schedule";

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

const SPLIT = [
  { day: "monday", openTime: "17:00", closeTime: "20:00" },
  { day: "Monday", openTime: "10:00", closeTime: "14:00" },
  { day: "saturday", openTime: "9:00", closeTime: "13:00" },
];

console.log("\n=== reading what the API stores ===");
const week = scheduleFromWorkingHours(SPLIT)!;
check("a split Monday is two shifts, in order", week.monday, {
  works: true,
  shifts: [
    { start: "10:00", end: "14:00" },
    { start: "17:00", end: "20:00" },
  ],
});
check("a day with no entries is a day off", week.tuesday, { works: false, shifts: [] });
check("times are padded to HH:MM", week.saturday.shifts[0], { start: "09:00", end: "13:00" });
check("nothing recorded is null, not a made-up week", scheduleFromWorkingHours([]), null);
check("the legacy object shape is not a schedule", scheduleFromWorkingHours({ monday: { start: "09:00", end: "18:00" } }), null);
check(
  "entries the server would skip are left out",
  scheduleFromWorkingHours([
    { day: "monday", openTime: "10:00", closeTime: "14:00" },
    { day: "monday", openTime: "20:00", closeTime: "17:00" },
    { day: "lunes", openTime: "10:00", closeTime: "14:00" },
  ])!.monday.shifts,
  [{ start: "10:00", end: "14:00" }],
);

console.log("\n=== writing it back ===");
check("round trip: Monday first, shifts by start, lower-case days", workingHoursFromSchedule(week), [
  { day: "monday", openTime: "10:00", closeTime: "14:00" },
  { day: "monday", openTime: "17:00", closeTime: "20:00" },
  { day: "saturday", openTime: "09:00", closeTime: "13:00" },
]);
const off: WeeklySchedule = { ...week, monday: { ...week.monday, works: false } };
check("a day switched off is not sent, even with shifts left in it", workingHoursFromSchedule(off).length, 1);
check("the default week is Monday to Friday, 09:00 to 19:00", workingHoursFromSchedule(defaultSchedule()).length, 5);

console.log("\n=== checking it ===");
check("a valid split day has no problem", dayProblem(week.monday), null);
check(
  "overlapping shifts",
  dayProblem({ works: true, shifts: [{ start: "10:00", end: "14:00" }, { start: "13:00", end: "17:00" }] }),
  "Los tramos 10:00–14:00 y 13:00–17:00 se solapan.",
);
check(
  "touching shifts are fine",
  dayProblem({ works: true, shifts: [{ start: "10:00", end: "14:00" }, { start: "14:00", end: "17:00" }] }),
  null,
);
check(
  "an end before the start",
  dayProblem({ works: true, shifts: [{ start: "18:00", end: "09:00" }] }),
  "El tramo que empieza a las 18:00 termina antes de empezar.",
);
check(
  "an empty time",
  dayProblem({ works: true, shifts: [{ start: "", end: "14:00" }] }),
  "Indica la hora de inicio y la de fin de cada tramo.",
);
check("a day off is never a problem", dayProblem({ works: false, shifts: [{ start: "x", end: "y" }] }), null);
const nobody = scheduleProblems(defaultSchedule());
check("the default week is valid", hasProblems(defaultSchedule()), false);
check("problems are reported per day", nobody.days, {});
let allOff = defaultSchedule();
for (const d of ["monday", "tuesday", "wednesday", "thursday", "friday"] as const) allOff = toggleDay(allOff, d);
check(
  "a week with no working day is refused (an empty list would mean no limit at all)",
  scheduleProblems(allOff).week !== null,
  true,
);

console.log("\n=== editing it ===");
const copied = copyMondayToWeekdays(week);
check("Monday copied to Tuesday to Friday", [copied.tuesday, copied.friday], [week.monday, week.monday]);
check("but not to the weekend", copied.saturday, week.saturday);
copied.tuesday.shifts[0].start = "11:00";
check("the copies are independent of Monday", copied.monday.shifts[0].start, "10:00");
const toggled = toggleDay(defaultSchedule(), "saturday");
check("switching a day on gives it the default shift", toggled.saturday, { works: true, shifts: [{ start: "09:00", end: "19:00" }] });
const lunch = addShift(scheduleFromWorkingHours([{ day: "monday", openTime: "10:00", closeTime: "14:00" }])!, "monday");
check("a new shift starts after the last one", lunch.monday.shifts[1], { start: "15:00", end: "17:00" });
check("no more than three shifts a day", addShift(addShift(lunch, "monday"), "monday").monday.shifts.length, 3);
check("removing the last shift switches the day off", removeShift(toggled, "saturday", 0).saturday, { works: false, shifts: [] });

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
