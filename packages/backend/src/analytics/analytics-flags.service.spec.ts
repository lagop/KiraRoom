/**
 * The analytics plan gate read the stored plan from the JWT with its own alias
 * map: a salon on its 14-day Pro trial (stored as "esencial" + trialing) got
 * the Esencial page, 3 months of history and a 403 from the Profesionales and
 * Clientas endpoints that FeatureGuard had just let through; an old
 * "enterprise" row was treated as Esencial. The flags now come from
 * FeatureFlagService (the effective plan), and the controller has no second
 * plan check. Staff are told what they can load.
 */
import { AnalyticsFlagsService, maxMonthsForPlan } from "./analytics-flags.service";
import { AnalyticsController } from "./analytics.controller";
import { FeatureFlagService } from "../common/feature-flags/feature-flag.service";
import { SubscriptionsService } from "../payments/services/subscriptions.service";

const DAY = 24 * 60 * 60 * 1000;

function tenantRow(over: Record<string, unknown> = {}) {
  return {
    id: "t1",
    plan: "esencial",
    subscriptionStatus: "active",
    trialEnd: null,
    addons: {},
    tenantAddOns: [],
    locations: [{ id: "loc-1" }],
    aiConversationsUsed: 0,
    aiFairUseAction: "degrade",
    aiConversationsResetAt: null,
    ...over,
  };
}

function setup(row: Record<string, unknown> | null) {
  const subs = new SubscriptionsService(
    {} as any,
    { get: () => undefined } as any,
    { client: () => null, current: () => ({ taxEnabled: false }) } as any,
  );
  const prisma: any = { tenant: { findUnique: jest.fn(async () => row) } };
  const featureFlags = new FeatureFlagService(prisma, subs);
  return new AnalyticsFlagsService(featureFlags);
}

describe("AnalyticsFlagsService", () => {
  it("a salon on its Pro trial gets Pro analytics and 6 months", async () => {
    const flags = setup(
      tenantRow({
        plan: "esencial",
        subscriptionStatus: "trialing",
        trialEnd: new Date(Date.now() + 7 * DAY),
      }),
    );
    expect(await flags.getFeatureFlags("t1", "owner")).toEqual({
      hasAdvancedAnalytics: true,
      maxMonths: 6,
    });
  });

  it("a trial that has ended is Esencial again", async () => {
    const flags = setup(
      tenantRow({ subscriptionStatus: "trialing", trialEnd: new Date(Date.now() - DAY) }),
    );
    expect(await flags.getFeatureFlags("t1", "owner")).toMatchObject({
      hasAdvancedAnalytics: false,
      maxMonths: 3,
    });
  });

  it("Esencial: no advanced analytics, 3 months", async () => {
    const flags = setup(tenantRow({ plan: "esencial" }));
    expect(await flags.getFeatureFlags("t1", "admin")).toEqual({
      hasAdvancedAnalytics: false,
      maxMonths: 3,
    });
  });

  it("Empresa, and a legacy 'enterprise' row, get 12 months", async () => {
    for (const plan of ["empresa", "enterprise"]) {
      const flags = setup(tenantRow({ plan }));
      expect(await flags.getFeatureFlags("t1", "owner")).toEqual({
        hasAdvancedAnalytics: true,
          maxMonths: 12,
      });
    }
  });

  it("legacy 'professional' is Pro and 'basic' is Esencial", async () => {
    expect(await setup(tenantRow({ plan: "professional" })).getMaxMonths("t1")).toBe(6);
    expect(await setup(tenantRow({ plan: "basic" })).getMaxMonths("t1")).toBe(3);
  });

  it("staff never get the manager-only parts, whatever the plan", async () => {
    const flags = setup(tenantRow({ plan: "empresa" }));
    expect(await flags.getFeatureFlags("t1", "staff")).toEqual({
      hasAdvancedAnalytics: false,
      maxMonths: 12,
    });
  });

  it("an add-on that unlocks advanced analytics counts", async () => {
    const flags = setup(
      tenantRow({ tenantAddOns: [{ addOn: { unlocks: ["advanced_analytics"] } }] }),
    );
    expect(await flags.getFeatureFlags("t1", "owner")).toMatchObject({
      hasAdvancedAnalytics: true,
      maxMonths: 3,
    });
  });

  it("an unknown tenant is Esencial", async () => {
    expect(await setup(null).getFeatureFlags("t1", "owner")).toEqual({
      hasAdvancedAnalytics: false,
      maxMonths: 3,
    });
  });

  it("clamps the requested months to the plan", async () => {
    const pro = setup(tenantRow({ plan: "pro" }));
    expect(await pro.clampMonths("t1", 12)).toBe(6);
    expect(await pro.clampMonths("t1", 3)).toBe(3);
    expect(await pro.clampMonths("t1", NaN)).toBe(6);
    expect(await pro.clampMonths("t1", -4, 1)).toBe(1);
    expect(await setup(tenantRow({ plan: "esencial" })).clampMonths("t1", 12)).toBe(3);
    expect(await setup(tenantRow({ plan: "empresa" })).clampMonths("t1", 1e9)).toBe(12);
  });

  it("maxMonthsForPlan has a floor of 3", () => {
    expect(maxMonthsForPlan(undefined)).toBe(3);
    expect(maxMonthsForPlan("advanced")).toBe(3); // not normalised: callers pass the effective plan
  });
});

describe("AnalyticsController uses the effective plan", () => {
  const req = { user: { id: "u1", tenantId: "t1", role: "owner", userId: "u1" } } as any;

  function controller(row: Record<string, unknown>) {
    const analytics: any = {
      getOverview: jest.fn(async () => ({})),
      getClientInsights: jest.fn(async () => ({})),
      getAppointmentStatusesEvolution: jest.fn(async () => []),
      getTopProfessionals: jest.fn(async () => []),
      todayFor: jest.fn(async () => ({ today: "2026-11-01", timezone: "Europe/Madrid" })),
    };
    const professionals: any = { getProfessionalByUserId: jest.fn() };
    return { ctl: new AnalyticsController(analytics, setup(row), professionals), analytics };
  }

  it("a trialing salon reads client insights (no 403 after the guard) with 6 months", async () => {
    const { ctl, analytics } = controller(
      tenantRow({ subscriptionStatus: "trialing", trialEnd: new Date(Date.now() + DAY) }),
    );
    await expect(ctl.getClientInsights(req, "12")).resolves.toEqual({});
    expect(analytics.getClientInsights).toHaveBeenCalledWith("t1", 6);
  });

  it("cuts overview and evolution months to the plan", async () => {
    const { ctl, analytics } = controller(tenantRow({ plan: "esencial" }));
    await ctl.getOverview(req, "12");
    await ctl.getAppointmentStatusesEvolution(req, "12");
    expect(analytics.getOverview).toHaveBeenCalledWith("t1", 3, null);
    expect(analytics.getAppointmentStatusesEvolution).toHaveBeenCalledWith("t1", 3);
  });

  it("cuts the professionals' range to the plan", async () => {
    const { ctl, analytics } = controller(tenantRow({ plan: "pro" }));
    await ctl.getProfessionalPerformance(req, "12_months");
    expect(analytics.getTopProfessionals).toHaveBeenCalledWith(
      "t1",
      { start: "2026-06-01", end: "2026-11-01" },
      10,
    );
  });

  it("the removed report endpoints are gone", () => {
    const proto = AnalyticsController.prototype as any;
    for (const name of [
      "getRevenueReport",
      "getAppointmentsReport",
      "getAppointmentStatusEvolution",
      "getDetailedReport",
    ]) {
      expect(proto[name]).toBeUndefined();
    }
  });
});
