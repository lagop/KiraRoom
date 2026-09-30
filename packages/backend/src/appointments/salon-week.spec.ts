import { salonWeekFrom } from "./working-hours";

/**
 * The salon's own week, derived from its professionals' schedules.
 *
 * The receptionist's prompt used to carry a hardcoded week — Monday to Friday
 * 09:00–18:00 plus Saturday 09:00–14:00 — for every salon on the platform. It
 * contradicted the schedules `check_availability` reads from the same rows: the
 * prompt announced Saturday opening at a salon whose only professional does not
 * work Saturdays, while the tool correctly refused to offer a slot. The model
 * was handed one version of reality and its tools another.
 */

const CARLA = {
  workingHours: [
    { day: "monday", openTime: "09:00", closeTime: "18:00" },
    { day: "tuesday", openTime: "09:00", closeTime: "19:00" },
  ],
};

describe("salonWeekFrom", () => {
  it("takes each professional's own hours", () => {
    expect(salonWeekFrom([CARLA])).toEqual({
      monday: { openTime: "09:00", closeTime: "18:00" },
      tuesday: { openTime: "09:00", closeTime: "19:00" },
    });
  });

  it("omits days nobody works", () => {
    // Not "closed 09:00-09:00" — absent, so the caller renders it as closed.
    expect(salonWeekFrom([CARLA]).saturday).toBeUndefined();
    expect(salonWeekFrom([CARLA]).sunday).toBeUndefined();
  });

  it("widens a day to the earliest open and the latest close", () => {
    // A salon is open when ANY professional is in, which is what a client
    // asking "when are you open?" means.
    const early = {
      workingHours: [{ day: "monday", openTime: "08:00", closeTime: "15:00" }],
    };
    const late = {
      workingHours: [{ day: "monday", openTime: "11:00", closeTime: "21:00" }],
    };

    expect(salonWeekFrom([early, late]).monday).toEqual({
      openTime: "08:00",
      closeTime: "21:00",
    });
  });

  it("does not narrow a day when a second professional works a subset", () => {
    const full = {
      workingHours: [{ day: "monday", openTime: "09:00", closeTime: "20:00" }],
    };
    const partTime = {
      workingHours: [{ day: "monday", openTime: "16:00", closeTime: "18:00" }],
    };

    expect(salonWeekFrom([full, partTime]).monday).toEqual({
      openTime: "09:00",
      closeTime: "20:00",
    });
  });

  it("adds a day only one professional works", () => {
    const weekend = {
      workingHours: [{ day: "saturday", openTime: "10:00", closeTime: "14:00" }],
    };

    const week = salonWeekFrom([CARLA, weekend]);
    expect(week.saturday).toEqual({ openTime: "10:00", closeTime: "14:00" });
    expect(week.monday).toEqual({ openTime: "09:00", closeTime: "18:00" });
  });

  it("returns an empty week when nobody has a schedule recorded", () => {
    // So the caller can say the hours are unknown instead of inventing them,
    // which is precisely how the hardcoded week got there.
    expect(salonWeekFrom([])).toEqual({});
    expect(salonWeekFrom([{ workingHours: [] }])).toEqual({});
    expect(salonWeekFrom([{ workingHours: undefined }])).toEqual({});
    expect(salonWeekFrom([{ workingHours: "nonsense" }])).toEqual({});
  });

  it("accepts capitalised weekday names", () => {
    const shouty = {
      workingHours: [{ day: "Monday", openTime: "09:00", closeTime: "18:00" }],
    };

    expect(salonWeekFrom([shouty]).monday).toEqual({
      openTime: "09:00",
      closeTime: "18:00",
    });
  });

  it("ignores entries that are not weekdays or not real windows", () => {
    const junk = {
      workingHours: [
        { day: "someday", openTime: "09:00", closeTime: "18:00" },
        { day: "monday", openTime: "18:00", closeTime: "09:00" },
        { day: "tuesday", openTime: "nope", closeTime: "18:00" },
        { day: "wednesday", openTime: "10:00", closeTime: "10:00" },
      ],
    };

    expect(salonWeekFrom([junk])).toEqual({});
  });
});
