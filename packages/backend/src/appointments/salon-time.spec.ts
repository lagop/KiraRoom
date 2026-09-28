import { salonInstant } from "./salon-time";

describe("salonInstant", () => {
  it("reads the wall clock in the salon's timezone", () => {
    // Madrid in summer is UTC+2.
    expect(salonInstant("2026-07-10", "10:00", "Europe/Madrid").toISOString()).toBe(
      "2026-07-10T08:00:00.000Z",
    );
    // Canarias is an hour behind Madrid.
    expect(salonInstant("2026-07-10", "10:00", "Atlantic/Canary").toISOString()).toBe(
      "2026-07-10T09:00:00.000Z",
    );
  });

  it("follows DST", () => {
    // Madrid in winter is UTC+1.
    expect(salonInstant("2026-01-10", "10:00", "Europe/Madrid").toISOString()).toBe(
      "2026-01-10T09:00:00.000Z",
    );
  });

  it("accepts the Date Prisma returns for a date column", () => {
    expect(
      salonInstant(new Date("2026-07-10T00:00:00.000Z"), "18:30", "Europe/Madrid").toISOString(),
    ).toBe("2026-07-10T16:30:00.000Z");
  });
});
