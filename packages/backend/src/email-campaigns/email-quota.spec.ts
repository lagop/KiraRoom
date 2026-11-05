import {
  EmailQuotaService,
  NEVER_PAID_EMAIL_CAP,
  capPauseReason,
  hasPaidKiraRoom,
  marketingEmailCap,
  nextMonthStart,
  salonMonth,
} from "./email-quota.service";

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

/** D2: a salon that has never paid sends at most 200 campaign emails a month. */
describe("never-paid cap", () => {
  const now = new Date("2026-11-10T10:00:00Z");

  function serviceFor(tenant: Record<string, unknown>) {
    const prisma = {
      tenant: { findUnique: jest.fn().mockResolvedValue({ timezone: "Europe/Madrid", maxLocations: 1, tenantAddOns: [], ...tenant }) },
      emailMarketingUsage: { createMany: jest.fn().mockResolvedValue({ count: 1 }) },
    };
    return new EmailQuotaService(prisma as never, { marketingPack: () => null } as never);
  }

  it("has paid: a paid invoice, or an active subscription", () => {
    expect(hasPaidKiraRoom({ firstPaidAt: null, subscriptionStatus: "trialing" })).toBe(false);
    expect(hasPaidKiraRoom({ firstPaidAt: null, subscriptionStatus: "past_due" })).toBe(false);
    expect(hasPaidKiraRoom({ firstPaidAt: new Date(), subscriptionStatus: "past_due" })).toBe(true);
    // Active on a Stripe subscription: paying, even before firstPaidAt is set.
    expect(hasPaidKiraRoom({ firstPaidAt: null, subscriptionStatus: "active", stripeSubscriptionId: "sub_1" })).toBe(true);
    // Active by hand, without Stripe (a courtesy, audit 8 D6): not paying.
    expect(hasPaidKiraRoom({ firstPaidAt: null, subscriptionStatus: "active" })).toBe(false);
    expect(
      hasPaidKiraRoom({ firstPaidAt: null, subscriptionStatus: "active", stripeSubscriptionId: null, courtesyUntil: new Date() }),
    ).toBe(false);
  });

  it("a trial gets 200 instead of Pro's 2,000; once paid, the plan's", async () => {
    const trial = await serviceFor({
      plan: "pro",
      subscriptionStatus: "trialing",
      trialEnd: new Date("2026-11-20T00:00:00Z"),
      firstPaidAt: null,
    }).limits("t1", now);
    expect(trial.cap).toBe(NEVER_PAID_EMAIL_CAP);
    expect(trial.neverPaidCap).toBe(true);

    const paid = await serviceFor({
      plan: "pro",
      subscriptionStatus: "past_due",
      trialEnd: null,
      firstPaidAt: new Date("2026-10-01T00:00:00Z"),
    }).limits("t1", now);
    expect(paid.cap).toBe(2000);
    expect(paid.neverPaidCap).toBe(false);
  });

  it("a plan with fewer emails than 200 keeps its own (Esencial: none)", async () => {
    const limits = await serviceFor({ plan: "esencial", subscriptionStatus: "past_due", trialEnd: null, firstPaidAt: null }).limits("t1", now);
    expect(limits.cap).toBe(0);
    expect(limits.neverPaidCap).toBe(false);
  });

  it("the pause says it is the trial's limit", () => {
    expect(capPauseReason({ cap: 200, resetsOn: "2026-12-01", neverPaidCap: true }, false)).toBe(
      "En pausa: hasta que pagues tu primera cuota, puedes enviar 200 emails de marketing al mes y ya se han enviado. " +
        "Lo que falta sigue pendiente y se enviará cuando actives tu suscripción, o solo el 1 de diciembre.",
    );
  });
});
