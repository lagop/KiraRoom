import { capPauseReason, marketingEmailCap, nextMonthStart, salonMonth } from "./email-quota.service";

/** The cap's arithmetic: plans, locations, the salon's month. */
describe("marketing email cap", () => {
  it("Pro 2,000; Empresa 5,000 per billed location; Esencial none, unless it has the add-on", () => {
    expect(marketingEmailCap("pro", { inTrial: false })).toBe(2000);
    expect(marketingEmailCap("empresa", { inTrial: false, locations: 1 })).toBe(5000);
    expect(marketingEmailCap("empresa", { inTrial: false, locations: 4 })).toBe(20000);
    expect(marketingEmailCap("empresa", { inTrial: false, locations: 0 })).toBe(5000);
    expect(marketingEmailCap("esencial", { inTrial: false })).toBe(0);
    expect(marketingEmailCap("esencial", { inTrial: false, addOn: true })).toBe(2000);
    // Legacy ids map as the plans do; the trial is Pro.
    expect(marketingEmailCap("professional", { inTrial: false })).toBe(2000);
    expect(marketingEmailCap("esencial", { inTrial: true })).toBe(2000);
  });

  it("the month and its end are the salon's", () => {
    const instant = new Date("2026-11-30T23:30:00Z");
    expect(salonMonth("Europe/Madrid", instant)).toBe("2026-12");
    expect(salonMonth("UTC", instant)).toBe("2026-11");
    expect(salonMonth("America/Mexico_City", new Date("2026-12-01T03:00:00Z"))).toBe("2026-11");
    expect(nextMonthStart("Europe/Madrid", new Date("2026-12-15T10:00:00Z"))).toBe("2027-01-01");
  });

  it("says why a campaign paused, and offers the bono only when it is on sale", () => {
    expect(capPauseReason({ cap: 2000, resetsOn: "2026-12-01" }, true)).toBe(
      "En pausa: este mes ya se han enviado los 2.000 emails de marketing de tu plan. " +
        "Lo que falta sigue pendiente y se enviará solo el 1 de diciembre, o antes si compras un bono de emails.",
    );
    expect(capPauseReason({ cap: 2000, resetsOn: "2026-12-01" }, false)).not.toMatch(/bono/);
  });
});
