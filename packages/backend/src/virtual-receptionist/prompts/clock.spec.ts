import { salonClock } from "./clock";

/**
 * In a real chat the receptionist, given only a UTC instant, offered "25 de
 * septiembre" and "2 de octubre" as the next Thursdays. Neither is one.
 */
describe("salonClock", () => {
  // Tuesday 29 September 2026, 11:29 UTC = 13:29 in Madrid.
  const NOW = new Date("2026-09-29T11:29:00.000Z");

  it("states today in the salon's timezone, with the weekday", () => {
    const clock = salonClock(NOW, "Europe/Madrid", "es");
    expect(clock).toContain("martes, 29 de septiembre de 2026, 13:29 (Europe/Madrid)");
    expect(clock).toContain("Hoy es 2026-09-29");
  });

  it("resolves the coming weekdays, so 'el jueves' is 1 October", () => {
    const clock = salonClock(NOW, "Europe/Madrid", "es");
    expect(clock).toContain("jueves 2026-10-01");
    expect(clock).toContain("jueves 2026-10-08");
    expect(clock).not.toContain("2026-09-25");
  });

  it("uses the salon's own date near midnight", () => {
    // 23:30 UTC on the 29th is already the 30th in Madrid.
    const clock = salonClock(new Date("2026-09-29T23:30:00.000Z"), "Europe/Madrid", "es");
    expect(clock).toContain("Hoy es 2026-09-30");
  });

  it("speaks English to an English salon", () => {
    const clock = salonClock(NOW, "Europe/London", "en");
    expect(clock).toContain("Tuesday, 29 September 2026, 12:29 (Europe/London)");
    expect(clock).toContain("Thursday 2026-10-01");
  });
});
