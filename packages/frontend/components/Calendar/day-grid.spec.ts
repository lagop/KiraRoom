/**
 * The calendar's day, across clock changes, and the day grid's layout.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only components/Calendar/day-grid.spec.ts
 *
 * Found on 2026-10-30: "next day" stuck on 29 March 2026 and skipped
 * 25 October 2026 with the browser in Madrid, and the calendar opened a day
 * early in America. The day walks below run with the process in each zone
 * (Node re-reads TZ when it is set).
 */
import {
  gridHours,
  holdsSlot,
  initialScrollMinutes,
  isBreakService,
  layoutLanes,
  localDay,
  offShiftBands,
  shiftsOn,
  dateOfDay,
  shiftDay,
  visibleProfessionals,
} from "./day-grid";

let pass = 0;
let fail = 0;
function check(name: string, ok: boolean, detail?: unknown) {
  if (ok) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`, detail ?? "");
  }
}

/** The calendar day after/before `day`, by UTC arithmetic (no local clock). */
function expected(day: string, delta: number): string {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + delta)).toISOString().slice(0, 10);
}

/** Every day of 2026 forwards and back, one click at a time. */
function walkYear(): string | null {
  let day = "2025-12-31";
  for (let i = 0; i < 366; i++) {
    const next = shiftDay(day, 1);
    if (next !== expected(day, 1)) return `${day} -> ${next}`;
    if (localDay(dateOfDay(next)) !== next) return `round trip of ${next}`;
    day = next;
  }
  for (let i = 0; i < 366; i++) {
    const prev = shiftDay(day, -1);
    if (prev !== expected(day, -1)) return `${day} <- ${prev}`;
    day = prev;
  }
  return day === "2025-12-31" ? null : `walked back to ${day}`;
}

// Madrid, New York, and Santiago de Chile (whose clocks change at midnight,
// so 6 September 2026 has no 00:00).
for (const zone of ["Europe/Madrid", "America/New_York", "America/Santiago"]) {
  process.env.TZ = zone;
  const broken = walkYear();
  check(`${zone}: next and previous day walk all of 2026`, broken === null, broken);
}

process.env.TZ = "Europe/Madrid";
check("Madrid: the day after 28 March is 29 March", shiftDay("2026-03-28", 1) === "2026-03-29");
check("Madrid: and after 29 March, 30 March (clocks forward)", shiftDay("2026-03-29", 1) === "2026-03-30");
check("Madrid: 25 October is not skipped (clocks back)", shiftDay("2026-10-24", 1) === "2026-10-25");
check("Madrid: back from 26 October is 25 October", shiftDay("2026-10-26", -1) === "2026-10-25");
check(
  "Madrid: half past midnight is already the new day (toISOString said yesterday)",
  localDay(new Date(2026, 9, 31, 0, 30)) === "2026-10-31" &&
    new Date(2026, 9, 31, 0, 30).toISOString().slice(0, 10) === "2026-10-30",
);

process.env.TZ = "America/New_York";
check("New York: a day opens on that day, not the one before", localDay(dateOfDay("2026-10-31")) === "2026-10-31");
check(
  "New York: late evening is still today (toISOString said tomorrow)",
  localDay(new Date(2026, 9, 30, 21, 0)) === "2026-10-30",
);
check("New York: 1 November (clocks back) is reached", shiftDay("2026-10-31", 1) === "2026-11-01" && shiftDay("2026-11-01", 1) === "2026-11-02");

process.env.TZ = "Europe/Madrid";

// --- The grid's hours ---
check("no hours known: 08:00 to 20:00", JSON.stringify(gridHours({ day: "2026-10-30" })) === '{"startHour":8,"endHour":20}');
check(
  "the salon's opening hours",
  JSON.stringify(gridHours({ day: "2026-10-30", openingHours: { open: "09:30", close: "18:15" } })) ===
    '{"startHour":9,"endHour":19}',
);
const workingHours = [
  [{ day: "friday", openTime: "10:00", closeTime: "14:00" }, { day: "saturday", openTime: "07:00", closeTime: "13:00" }],
  [{ day: "Friday", openTime: "16:00", closeTime: "21:00" }],
];
check(
  "the professionals' hours for that weekday (30 Oct 2026 is a Friday)",
  JSON.stringify(gridHours({ day: "2026-10-30", workingHours })) === '{"startHour":10,"endHour":21}',
);
check(
  "widened to cover an appointment outside them",
  JSON.stringify(
    gridHours({ day: "2026-10-30", openingHours: { open: "09:00", close: "18:00" }, appointments: [{ start: 7 * 60 + 30, end: 8 * 60 }, { start: 20 * 60, end: 21 * 60 + 10 }] }),
  ) === '{"startHour":7,"endHour":22}',
);
check(
  "an appointment past midnight does not run the grid past 24:00",
  gridHours({ day: "2026-10-30", appointments: [{ start: 23 * 60, end: 25 * 60 }] }).endHour === 24,
);
check("nonsense opening hours are ignored", gridHours({ day: "2026-10-30", openingHours: { open: "x", close: "18:00" } }).startHour === 8);

// --- Status, breaks, columns ---
check("cancelled and no-show appointments do not hold the slot", !holdsSlot("cancelled") && !holdsSlot("no_show"));
check("every other status does", holdsSlot("confirmed") && holdsSlot("pending") && holdsSlot("completed") && holdsSlot(undefined));
check("a break in Spanish is a break", isBreakService("Comida") && isBreakService("Descanso 30 min") && isBreakService("Pausa café"));
check("and in English", isBreakService("Lunch break"));
check("a service is not", !isBreakService("Corte y peinado") && !isBreakService("Manicura") && !isBreakService(undefined));

const pros = [
  { id: "a", isActive: true },
  { id: "b", isActive: false },
  { id: "c", isActive: false },
  { id: "d" },
];
check(
  "inactive professionals are not columns, unless they have appointments that day",
  visibleProfessionals(pros, [{ professionalId: "c" }]).map((p) => p.id).join() === "a,c,d",
);

// --- Lanes ---
const lanes = layoutLanes([
  { id: "x", start: 600, end: 660 },
  { id: "y", start: 630, end: 690 },
  { id: "z", start: 660, end: 720 },
  { id: "w", start: 800, end: 830 },
]);
check("two overlapping appointments sit side by side", lanes.get("x")!.lane === 0 && lanes.get("y")!.lane === 1, lanes);
check("the next one reuses the lane freed before it", lanes.get("z")!.lane === 0, lanes);
check("all three of the group split the column in two", [..."xyz"].every((id) => lanes.get(id)!.lanes === 2), lanes);
check("one on its own takes the whole column", lanes.get("w")!.lane === 0 && lanes.get("w")!.lanes === 1, lanes);

// --- Where the grid opens ---
check("today: an hour before now", initialScrollMinutes({ isToday: true, nowMinutes: 16 * 60, startHour: 8 }) === 15 * 60);
check(
  "another day: just before the first appointment",
  initialScrollMinutes({ isToday: false, nowMinutes: 16 * 60, firstAppointment: 17 * 60, startHour: 8 }) === 16 * 60 + 30,
);
check("an empty day: the top", initialScrollMinutes({ isToday: false, nowMinutes: 0, startHour: 9 }) === 9 * 60);

// --- Time outside the shifts, shaded per column ---
// 2026-11-02 is a Monday. A split day: 10:00-14:00 and 17:00-20:00, saved
// afternoon first, with a Tuesday that must not leak into Monday.
const SPLIT = [
  { day: "monday", openTime: "17:00", closeTime: "20:00" },
  { day: "Monday", openTime: "10:00", closeTime: "14:00" },
  { day: "tuesday", openTime: "08:00", closeTime: "21:00" },
];
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const range = { startHour: 8, endHour: 21 };
check(
  "a split day has both shifts, in order",
  same(shiftsOn("2026-11-02", SPLIT), [{ start: 600, end: 840 }, { start: 1020, end: 1200 }]),
  shiftsOn("2026-11-02", SPLIT),
);
check(
  "shaded: before, the lunch gap, and after",
  same(offShiftBands("2026-11-02", SPLIT, range), [
    { start: 480, end: 600 },
    { start: 840, end: 1020 },
    { start: 1200, end: 1260 },
  ]),
  offShiftBands("2026-11-02", SPLIT, range),
);
check(
  "a day off is shaded entirely",
  same(offShiftBands("2026-11-04", SPLIT, range), [{ start: 480, end: 1260 }]),
  offShiftBands("2026-11-04", SPLIT, range),
);
check(
  "no schedule recorded: nothing shaded",
  same(offShiftBands("2026-11-02", [], range), []) && same(offShiftBands("2026-11-02", undefined, range), []),
);
check(
  "a shift past the drawn hours is clipped to them",
  same(offShiftBands("2026-11-03", SPLIT, { startHour: 9, endHour: 20 }), []),
  offShiftBands("2026-11-03", SPLIT, { startHour: 9, endHour: 20 }),
);
check(
  "touching shifts leave no gap",
  same(
    offShiftBands(
      "2026-11-02",
      [
        { day: "monday", openTime: "09:00", closeTime: "14:00" },
        { day: "monday", openTime: "14:00", closeTime: "18:00" },
      ],
      { startHour: 9, endHour: 18 },
    ),
    [],
  ),
);
check(
  "a malformed shift is skipped, the good one kept",
  same(
    shiftsOn("2026-11-02", [
      { day: "monday", openTime: "10:00", closeTime: "14:00" },
      { day: "monday", openTime: "20:00", closeTime: "17:00" },
    ]),
    [{ start: 600, end: 840 }],
  ),
);

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
