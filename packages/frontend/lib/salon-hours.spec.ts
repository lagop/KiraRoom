/**
 * The salon's own opening hours in settings: how a stored value is shown, and
 * what saving sends.
 *
 * Run: npx ts-node --project tsconfig.test.json --transpile-only lib/salon-hours.spec.ts
 *
 * Settings had one opening and one closing time for every day, and a
 * "working days" list that was never saved. The salon's week now has shifts
 * per day, like a professional's schedule, or no salon-level hours at all.
 */
import {
  SALON_WEEK_EMPTY,
  openingHoursForSave,
  salonHoursEntries,
  salonHoursProblem,
  salonHoursSettingFrom,
  salonWindowsOn,
  sameSalonHours,
} from "./salon-hours";
import { toggleDay, updateShift, workingHoursFromSchedule } from "./weekly-schedule";

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

const WEEK = [
  { day: "monday", openTime: "10:00", closeTime: "14:00" },
  { day: "monday", openTime: "17:00", closeTime: "20:00" },
  { day: "saturday", openTime: "10:00", closeTime: "14:00" },
];

console.log("reading what is stored");
check("the list format is the salon's week", salonHoursEntries(WEEK), WEEK);
check(
  "the legacy { open, close } is that window every day",
  salonHoursEntries({ open: "9:30", close: "19:00" })?.map((e) => `${e.day} ${e.openTime}-${e.closeTime}`),
  [
    "monday 09:30-19:00",
    "tuesday 09:30-19:00",
    "wednesday 09:30-19:00",
    "thursday 09:30-19:00",
    "friday 09:30-19:00",
    "saturday 09:30-19:00",
    "sunday 09:30-19:00",
  ],
);
check(
  "nothing recorded: {}, [], null, a reversed pair, the old wizard's days",
  [{}, [], null, { open: "20:00", close: "09:00" }, { mon: { open: "09:00", close: "19:00" } }].map(salonHoursEntries),
  [undefined, undefined, undefined, undefined, undefined],
);
check("a weekday's windows", salonWindowsOn(WEEK, "monday"), [
  { start: 600, end: 840 },
  { start: 1020, end: 1200 },
]);
check("a weekday without hours is closed", salonWindowsOn(WEEK, "sunday"), []);
check("no hours recorded: no limit", salonWindowsOn({}, "sunday"), undefined);

console.log("what settings shows");
{
  const own = salonHoursSettingFrom(WEEK);
  check("the salon's week, limited", own.limited, true);
  check("its shifts, Monday split", own.week.monday, {
    works: true,
    shifts: [
      { start: "10:00", end: "14:00" },
      { start: "17:00", end: "20:00" },
    ],
  });
  check("a day without hours shows closed", own.week.sunday, { works: false, shifts: [] });

  const legacy = salonHoursSettingFrom({ open: "09:00", close: "20:00" });
  check("the legacy pair shows as every day", legacy.limited && legacy.week.sunday.works, true);

  const none = salonHoursSettingFrom({});
  check("nothing recorded: no salon hours", none.limited, false);
  check("with Monday to Friday 09:00–19:00 ready to switch on", none.week.monday.shifts, [{ start: "09:00", end: "19:00" }]);

  const wizard = salonHoursSettingFrom({ mon: { open: "10:00", close: "18:00" }, sat: { open: "10:00", close: "13:00" }, sun: null });
  check("the old wizard's week is offered, not applied", wizard.limited, false);
  check("as it was entered", workingHoursFromSchedule(wizard.week), [
    { day: "monday", openTime: "10:00", closeTime: "18:00" },
    { day: "saturday", openTime: "10:00", closeTime: "13:00" },
  ]);
}

console.log("what saving sends");
{
  const own = salonHoursSettingFrom(WEEK);
  check("the week in the list format", openingHoursForSave(own), WEEK);
  check("no salon hours sends []", openingHoursForSave({ ...own, limited: false }), []);
  check("unchanged is not sent again", sameSalonHours(own, salonHoursSettingFrom(WEEK)), true);
  check("a changed shift is", sameSalonHours(own, { ...own, week: updateShift(own.week, "monday", 0, { start: "09:00" }) }), false);
  check(
    "switching off with no hours before is no change",
    sameSalonHours(salonHoursSettingFrom({}), { ...salonHoursSettingFrom({}), week: toggleDay(salonHoursSettingFrom({}).week, "sunday") }),
    true,
  );
}

console.log("what is refused before saving");
{
  const own = salonHoursSettingFrom(WEEK);
  check("a good week", salonHoursProblem(own), null);
  check(
    "a shift ending before it starts, named by day",
    salonHoursProblem({ ...own, week: updateShift(own.week, "saturday", 0, { end: "09:00" }) }),
    "Sábado: El tramo que empieza a las 10:00 termina antes de empezar.",
  );
  let closed = own.week;
  for (const day of ["monday", "saturday"] as const) closed = toggleDay(closed, day);
  check("every day closed: choose no salon hours instead", salonHoursProblem({ limited: true, week: closed }), SALON_WEEK_EMPTY);
  check("no salon hours: nothing to check", salonHoursProblem({ limited: false, week: closed }), null);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
