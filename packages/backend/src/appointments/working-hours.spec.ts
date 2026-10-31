import {
  workingWindowsFor,
  fitsInWindow,
  fitsInShifts,
  mergeWindows,
  describeShifts,
  minutesOf,
  weekdayNameOf,
  parseWorkingHours,
  subtractWindows,
  candidateStarts,
} from "./working-hours";

/**
 * Availability has to respect the professional's shift.
 *
 * `getAvailableSlots` built the day's slots from the tenant's `openingHours` —
 * read as one `{ open, close }` pair for the whole week — and then only
 * checked for clashes with existing appointments. It never looked at
 * `professionals.workingHours`, which is the one place the onboarding wizard
 * actually writes a schedule.
 *
 * The test salon showed what that means: Carla works Monday to Friday, Monday
 * 09:00–18:00, and the tenant's `openingHours` is `{}`. So availability fell
 * back to 09:00–20:00 every day of the week, including the Sunday the salon is
 * shut.
 */

// As the onboarding wizard stores it.
const CARLA = [
  { day: "monday", openTime: "09:00", closeTime: "18:00" },
  { day: "tuesday", openTime: "09:00", closeTime: "19:00" },
  { day: "wednesday", openTime: "09:00", closeTime: "19:00" },
  { day: "thursday", openTime: "09:00", closeTime: "19:00" },
  { day: "friday", openTime: "09:00", closeTime: "19:00" },
];

const SUNDAY = new Date("2026-09-27T00:00:00.000Z");
const MONDAY = new Date("2026-09-28T00:00:00.000Z");
const TUESDAY = new Date("2026-09-29T00:00:00.000Z");

describe("weekdayNameOf", () => {
  it("names the weekday the way the wizard does", () => {
    expect(weekdayNameOf(SUNDAY)).toBe("sunday");
    expect(weekdayNameOf(MONDAY)).toBe("monday");
    expect(weekdayNameOf(TUESDAY)).toBe("tuesday");
  });
});

describe("minutesOf", () => {
  it("converts a time of day", () => {
    expect(minutesOf("09:00")).toBe(540);
    expect(minutesOf("18:30")).toBe(1110);
    expect(minutesOf("00:00")).toBe(0);
  });

  it("returns null for anything it cannot read", () => {
    for (const bad of ["", "9", "99:00", "09:99", "nueve", "09:00:00"]) {
      expect(minutesOf(bad)).toBeNull();
    }
  });
});

describe("workingWindowsFor", () => {
  it("closes the day the professional does not work", () => {
    // The bug: Sunday slots were offered for a salon shut on Sunday.
    expect(workingWindowsFor(CARLA, SUNDAY)).toEqual([]);
  });

  it("returns the shift for a day she does work", () => {
    expect(workingWindowsFor(CARLA, MONDAY)).toEqual([{ startMinutes: 540, endMinutes: 1080 }]);
  });

  it("uses that day's own hours, not one pair for the week", () => {
    // Monday ends at 18:00, Tuesday at 19:00. A single {open, close} for the
    // whole week cannot express this, which is why the tenant-level field was
    // never enough.
    expect(workingWindowsFor(CARLA, MONDAY)?.[0].endMinutes).toBe(1080);
    expect(workingWindowsFor(CARLA, TUESDAY)?.[0].endMinutes).toBe(1140);
  });

  it("imposes no limit when no schedule was ever recorded", () => {
    // Every salon that existed before this change has no workingHours. They
    // must stay bookable: undefined means "no constraint", not "never".
    expect(workingWindowsFor([], MONDAY)).toBeUndefined();
    expect(workingWindowsFor(null, MONDAY)).toBeUndefined();
    expect(workingWindowsFor(undefined, MONDAY)).toBeUndefined();
    expect(workingWindowsFor("not an array", MONDAY)).toBeUndefined();
    // The legacy seed shape, an object keyed by day, is not a list of shifts.
    expect(workingWindowsFor({ monday: { start: "09:00", end: "18:00" } }, MONDAY)).toBeUndefined();
  });

  it("closes the day rather than opening it wide on a malformed entry", () => {
    // A broken row is not a licence to book at any hour.
    expect(workingWindowsFor([{ day: "monday", openTime: "abc", closeTime: "18:00" }], MONDAY)).toEqual([]);
    expect(workingWindowsFor([{ day: "monday", openTime: "18:00", closeTime: "09:00" }], MONDAY)).toEqual([]);
    expect(workingWindowsFor([{ day: "monday", openTime: "09:00", closeTime: "09:00" }], MONDAY)).toEqual([]);
  });

  it("is case-insensitive about the day name", () => {
    expect(
      workingWindowsFor([{ day: "Monday", openTime: "10:00", closeTime: "14:00" }], MONDAY),
    ).toEqual([{ startMinutes: 600, endMinutes: 840 }]);
  });

  describe("a split day (jornada partida)", () => {
    // Two entries for the same day are two shifts. The single-window version
    // used find(), so the afternoon was never read.
    const SPLIT = [
      { day: "monday", openTime: "17:00", closeTime: "20:00" },
      { day: "monday", openTime: "10:00", closeTime: "14:00" },
      { day: "tuesday", openTime: "09:00", closeTime: "18:00" },
    ];

    it("returns every shift, sorted by start", () => {
      expect(workingWindowsFor(SPLIT, MONDAY)).toEqual([
        { startMinutes: 600, endMinutes: 840 },
        { startMinutes: 1020, endMinutes: 1200 },
      ]);
      expect(workingWindowsFor(SPLIT, TUESDAY)).toEqual([{ startMinutes: 540, endMinutes: 1080 }]);
    });

    it("skips a malformed shift and keeps the good one", () => {
      const half = [
        { day: "monday", openTime: "10:00", closeTime: "14:00" },
        { day: "monday", openTime: "20:00", closeTime: "17:00" },
      ];
      expect(workingWindowsFor(half, MONDAY)).toEqual([{ startMinutes: 600, endMinutes: 840 }]);
    });

    it("joins shifts that touch or overlap, so nothing outside them is offered", () => {
      const joined = [
        { day: "monday", openTime: "10:00", closeTime: "14:00" },
        { day: "monday", openTime: "14:00", closeTime: "16:00" },
        { day: "monday", openTime: "15:00", closeTime: "18:00" },
      ];
      expect(workingWindowsFor(joined, MONDAY)).toEqual([{ startMinutes: 600, endMinutes: 1080 }]);
    });
  });
});

describe("mergeWindows", () => {
  it("keeps separate windows apart and in order", () => {
    expect(
      mergeWindows([
        { startMinutes: 1020, endMinutes: 1200 },
        { startMinutes: 600, endMinutes: 840 },
      ]),
    ).toEqual([
      { startMinutes: 600, endMinutes: 840 },
      { startMinutes: 1020, endMinutes: 1200 },
    ]);
  });

  it("does not modify its input", () => {
    const input = [
      { startMinutes: 600, endMinutes: 840 },
      { startMinutes: 700, endMinutes: 900 },
    ];
    mergeWindows(input);
    expect(input[0].endMinutes).toBe(840);
  });
});

describe("fitsInShifts", () => {
  // 10:00–14:00 and 17:00–20:00.
  const split = [
    { startMinutes: 600, endMinutes: 840 },
    { startMinutes: 1020, endMinutes: 1200 },
  ];

  it("fits when one shift holds the whole service", () => {
    expect(fitsInShifts(780, 60, split)).toBe(true); // 13:00–14:00
    expect(fitsInShifts(1020, 60, split)).toBe(true); // 17:00–18:00
    expect(fitsInShifts(1140, 60, split)).toBe(true); // 19:00–20:00
  });

  it("does not fit across the gap, nor in it", () => {
    expect(fitsInShifts(810, 60, split)).toBe(false); // 13:30–14:30
    expect(fitsInShifts(900, 60, split)).toBe(false); // 15:00
    expect(fitsInShifts(990, 60, split)).toBe(false); // 16:30–17:30
  });

  it("nothing fits on a day off", () => {
    expect(fitsInShifts(600, 30, [])).toBe(false);
  });
});

describe("describeShifts", () => {
  it("names every shift the way a salon says it", () => {
    expect(
      describeShifts([
        { startMinutes: 600, endMinutes: 840 },
        { startMinutes: 1020, endMinutes: 1200 },
      ]),
    ).toBe("10:00–14:00 y 17:00–20:00");
    expect(describeShifts([{ startMinutes: 540, endMinutes: 1080 }])).toBe("09:00–18:00");
  });
});

describe("parseWorkingHours", () => {
  it("drops entries that are not shaped like a shift", () => {
    const mixed = [
      { day: "monday", openTime: "09:00", closeTime: "18:00" },
      { day: "tuesday" },
      null,
      "friday",
      { openTime: "09:00", closeTime: "18:00" },
    ];

    expect(parseWorkingHours(mixed)).toEqual([
      { day: "monday", openTime: "09:00", closeTime: "18:00" },
    ]);
  });
});

describe("fitsInWindow", () => {
  const monday = { startMinutes: 540, endMinutes: 1080 }; // 09:00–18:00

  it("accepts a slot that ends exactly at closing", () => {
    // 17:30 + 30 min = 18:00.
    expect(fitsInWindow(1050, 30, monday)).toBe(true);
  });

  it("rejects a slot that starts before closing but runs past it", () => {
    // 17:45 + 30 min = 18:15: the appointment would outlast the shift. The old
    // code offered 19:30 on this day, so this is the case that mattered.
    expect(fitsInWindow(1065, 30, monday)).toBe(false);
  });

  it("rejects a slot before opening", () => {
    expect(fitsInWindow(510, 30, monday)).toBe(false);
  });

  it("accepts the first slot of the day", () => {
    expect(fitsInWindow(540, 30, monday)).toBe(true);
  });

  it("takes the service duration into account", () => {
    // A 30-minute cut fits at 17:30; a 90-minute colour does not.
    expect(fitsInWindow(1050, 30, monday)).toBe(true);
    expect(fitsInWindow(1050, 90, monday)).toBe(false);
  });
});

describe("subtractWindows", () => {
  const w = (a: string, b: string) => ({ startMinutes: minutesOf(a)!, endMinutes: minutesOf(b)! });

  it("leaves the shifts as they are when nothing is blocked", () => {
    expect(subtractWindows([w("10:00", "14:00")], [])).toEqual([w("10:00", "14:00")]);
  });

  it("cuts a block out of the middle of a shift, leaving two windows", () => {
    expect(subtractWindows([w("09:00", "18:00")], [w("11:00", "12:30")])).toEqual([
      w("09:00", "11:00"),
      w("12:30", "18:00"),
    ]);
  });

  it("trims a shift a block overlaps at either end", () => {
    expect(subtractWindows([w("09:00", "14:00"), w("17:00", "20:00")], [w("08:00", "10:00"), w("19:00", "21:00")])).toEqual([
      w("10:00", "14:00"),
      w("17:00", "19:00"),
    ]);
  });

  it("removes a shift a block covers entirely, and keeps the other one", () => {
    expect(subtractWindows([w("10:00", "14:00"), w("17:00", "20:00")], [w("09:00", "15:00")])).toEqual([
      w("17:00", "20:00"),
    ]);
  });

  it("joins overlapping blocks before cutting, in any order", () => {
    expect(subtractWindows([w("09:00", "18:00")], [w("12:00", "13:00"), w("10:00", "12:30")])).toEqual([
      w("09:00", "10:00"),
      w("13:00", "18:00"),
    ]);
  });

  it("ignores an empty or inverted block", () => {
    expect(subtractWindows([w("09:00", "18:00")], [w("12:00", "12:00"), w("13:00", "11:00")])).toEqual([
      w("09:00", "18:00"),
    ]);
  });

  it("a block touching a shift end to end takes nothing", () => {
    expect(subtractWindows([w("10:00", "14:00")], [w("14:00", "16:00")])).toEqual([w("10:00", "14:00")]);
  });
});

describe("candidateStarts", () => {
  const w = (a: string, b: string) => ({ startMinutes: minutesOf(a)!, endMinutes: minutesOf(b)! });
  const clocks = (ms: number[]) => ms.map((m) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);

  it("is the salon window in half hours when nobody works outside it", () => {
    expect(clocks(candidateStarts(w("09:00", "11:00"), [w("09:00", "10:00")]))).toEqual(["09:00", "09:30", "10:00", "10:30"]);
  });

  it("reaches a shift past the salon window", () => {
    const starts = clocks(candidateStarts(w("09:00", "20:00"), [w("18:00", "22:00")]));
    expect(starts).toContain("20:00");
    expect(starts).toContain("21:30");
    expect(starts).not.toContain("22:00");
  });

  it("starts a slot at a shift start off the half hour, then keeps to the half hours", () => {
    const starts = clocks(candidateStarts(w("09:00", "10:00"), [w("10:15", "12:00")]));
    expect(starts).toEqual(["09:00", "09:30", "10:15", "10:30", "11:00", "11:30"]);
  });
});
