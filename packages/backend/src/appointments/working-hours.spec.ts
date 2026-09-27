import {
  workingWindowFor,
  fitsInWindow,
  minutesOf,
  weekdayNameOf,
  parseWorkingHours,
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

describe("workingWindowFor", () => {
  it("closes the day the professional does not work", () => {
    // The bug: Sunday slots were offered for a salon shut on Sunday.
    expect(workingWindowFor(CARLA, SUNDAY)).toBeNull();
  });

  it("returns the shift for a day she does work", () => {
    expect(workingWindowFor(CARLA, MONDAY)).toEqual({
      startMinutes: 540,
      endMinutes: 1080,
    });
  });

  it("uses that day's own hours, not one pair for the week", () => {
    // Monday ends at 18:00, Tuesday at 19:00. A single {open, close} for the
    // whole week cannot express this, which is why the tenant-level field was
    // never enough.
    expect(workingWindowFor(CARLA, MONDAY)?.endMinutes).toBe(1080);
    expect(workingWindowFor(CARLA, TUESDAY)?.endMinutes).toBe(1140);
  });

  it("imposes no limit when no schedule was ever recorded", () => {
    // Every salon that existed before this change has no workingHours. They
    // must stay bookable: undefined means "no constraint", not "never".
    expect(workingWindowFor([], MONDAY)).toBeUndefined();
    expect(workingWindowFor(null, MONDAY)).toBeUndefined();
    expect(workingWindowFor(undefined, MONDAY)).toBeUndefined();
    expect(workingWindowFor("not an array", MONDAY)).toBeUndefined();
  });

  it("closes the day rather than opening it wide on a malformed entry", () => {
    // A broken row is not a licence to book at any hour.
    expect(
      workingWindowFor([{ day: "monday", openTime: "abc", closeTime: "18:00" }], MONDAY),
    ).toBeNull();
    expect(
      workingWindowFor([{ day: "monday", openTime: "18:00", closeTime: "09:00" }], MONDAY),
    ).toBeNull();
    expect(
      workingWindowFor([{ day: "monday", openTime: "09:00", closeTime: "09:00" }], MONDAY),
    ).toBeNull();
  });

  it("is case-insensitive about the day name", () => {
    expect(
      workingWindowFor([{ day: "Monday", openTime: "10:00", closeTime: "14:00" }], MONDAY),
    ).toEqual({ startMinutes: 600, endMinutes: 840 });
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
