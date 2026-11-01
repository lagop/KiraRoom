/**
 * Analítica by period preset and by location (S2, D12). The page offered only
 * 3/6/12 months while Multi-local's report spoke of "este mes", "mes pasado"
 * and "últimos 30 días"; and an Empresa salon could see one location's
 * figures only there. The overview, the rates, the status charts and the Pro
 * tabs now take a named `range` (cut to the plan) and a `locationId`, which
 * must be one of the salon's own locations.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { AnalyticsController } from "./analytics.controller";
import { AnalyticsFlagsService } from "./analytics-flags.service";
import { AnalyticsService } from "./analytics.service";
import {
  appointmentLocationWhere,
  isLocationId,
  locationScopeOf,
  tillLocationWhere,
} from "./analytics-location";
import { comparisonPeriod, parseRangeKey, windowPeriods } from "./analytics-metrics";
import { FeatureFlagService } from "../common/feature-flags/feature-flag.service";
import { SubscriptionsService } from "../payments/services/subscriptions.service";

const LOC_A = "11111111-1111-4111-8111-111111111111";
const LOC_B = "22222222-2222-4222-8222-222222222222";
const OTHER_SALON_LOC = "33333333-3333-4333-8333-333333333333";

describe("named ranges", () => {
  it("parses the range ids the page and the consolidated report share", () => {
    for (const r of ["this_month", "last_month", "last_30_days", "3_months", "6_months", "12_months"]) {
      expect(parseRangeKey(r)).toBe(r);
    }
    expect(parseRangeKey("1_year")).toBe("12_months");
    expect(parseRangeKey("forever")).toBeNull();
    expect(parseRangeKey("")).toBeNull();
    expect(parseRangeKey(undefined)).toBeNull();
  });

  it("compares each range with a fair previous period", () => {
    // This month so far: the same days of last month.
    expect(comparisonPeriod("this_month", { start: "2026-11-01", end: "2026-11-12" })).toEqual({
      start: "2026-10-01",
      end: "2026-10-12",
    });
    // Last month: the whole month before (September against all 31 days of August).
    expect(comparisonPeriod("last_month", { start: "2026-09-01", end: "2026-09-30" })).toEqual({
      start: "2026-08-01",
      end: "2026-08-31",
    });
    // The last 30 days: the 30 days before them.
    expect(comparisonPeriod("last_30_days", { start: "2026-10-03", end: "2026-11-01" })).toEqual({
      start: "2026-09-03",
      end: "2026-10-02",
    });
    // A week: the same weekdays a week earlier.
    expect(comparisonPeriod("this_week", { start: "2026-10-26", end: "2026-10-28" })).toEqual({
      start: "2026-10-19",
      end: "2026-10-21",
    });
    // Months after the plan's cut: 12 months on Pro (6) compare 6 months back.
    expect(comparisonPeriod("12_months", { start: "2026-06-01", end: "2026-11-01" }, 6)).toEqual({
      start: "2025-12-01",
      end: "2026-05-01",
    });
  });

  it("windowPeriods keeps the old months behaviour and cuts ranges to the plan", () => {
    expect(windowPeriods(3, "2026-11-01")).toEqual({
      period: { start: "2026-09-01", end: "2026-11-01" },
      previous: { start: "2026-06-01", end: "2026-08-01" },
    });
    expect(windowPeriods({ range: "12_months", maxMonths: 3 }, "2026-11-01").period).toEqual({
      start: "2026-09-01",
      end: "2026-11-01",
    });
    expect(windowPeriods({ range: "last_month", maxMonths: 3 }, "2026-11-01")).toEqual({
      period: { start: "2026-10-01", end: "2026-10-31" },
      previous: { start: "2026-09-01", end: "2026-09-30" },
    });
  });
});

describe("a location's scope", () => {
  const links = [
    { professionalId: "ana", locationId: LOC_A, isPrimary: false }, // only A
    { professionalId: "bea", locationId: LOC_A, isPrimary: false }, // both, B primary
    { professionalId: "bea", locationId: LOC_B, isPrimary: true },
    { professionalId: "eva", locationId: LOC_A, isPrimary: false }, // both, none primary
    { professionalId: "eva", locationId: LOC_B, isPrimary: false },
  ];

  it("holds the professionals whose home it is, as Multi-local's report places them", () => {
    expect(locationScopeOf({ id: LOC_A, name: "Centro" }, links, [LOC_A, LOC_B])).toEqual({
      locationId: LOC_A,
      name: "Centro",
      professionalIds: ["ana"],
    });
    expect(locationScopeOf({ id: LOC_B, name: "Norte" }, links, [LOC_A, LOC_B]).professionalIds).toEqual(["bea"]);
  });

  it("a closed location keeps its history", () => {
    // B is closed: Eva and Bea are only at A among the active ones, but B still counts for itself.
    expect(locationScopeOf({ id: LOC_B, name: "Norte" }, links, [LOC_A]).professionalIds).toEqual(["bea"]);
  });

  it("filters appointments booked there, or by its professionals when they have no location", () => {
    expect(appointmentLocationWhere(undefined)).toEqual({});
    expect(appointmentLocationWhere({ locationId: LOC_A, name: "Centro", professionalIds: ["ana"] })).toEqual({
      OR: [{ locationId: LOC_A }, { locationId: null, professionalId: { in: ["ana"] } }],
    });
  });

  it("keeps only its professionals' services at the till (products have no location)", () => {
    expect(tillLocationWhere(undefined, ["service", "product"])).toEqual({ kind: { in: ["service", "product"] } });
    expect(tillLocationWhere({ locationId: LOC_A, name: "Centro", professionalIds: ["ana"] }, ["service", "product"])).toEqual({
      kind: "service",
      professionalId: { in: ["ana"] },
    });
  });

  it("takes only UUIDs as ids", () => {
    expect(isLocationId(LOC_A)).toBe(true);
    expect(isLocationId("centro")).toBe(false);
    expect(isLocationId(`${LOC_A} OR 1=1`)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Controller and service, with a mocked Prisma
// ---------------------------------------------------------------------------

function tenantRow(plan: string) {
  return {
    id: "t1",
    plan,
    subscriptionStatus: "active",
    trialEnd: null,
    addons: {},
    tenantAddOns: [],
    locations: [{ id: LOC_A }, { id: LOC_B }],
    aiConversationsUsed: 0,
    aiFairUseAction: "degrade",
    aiConversationsResetAt: null,
  };
}

function makePrisma(plan: string) {
  const locations = [
    { id: LOC_A, tenantId: "t1", name: "Centro", isActive: true },
    { id: LOC_B, tenantId: "t1", name: "Norte", isActive: true },
    { id: OTHER_SALON_LOC, tenantId: "t2", name: "Otro salón", isActive: true },
  ];
  return {
    tenant: {
      findUnique: jest.fn(async (args: any) =>
        args.select?.timezone && Object.keys(args.select).length === 1 ? { timezone: "Europe/Madrid" } : tenantRow(plan),
      ),
    },
    location: {
      findFirst: jest.fn(async (args: any) =>
        locations.find((l) => l.id === args.where.id && l.tenantId === args.where.tenantId) ?? null,
      ),
      findMany: jest.fn(async (args: any) =>
        locations.filter((l) => l.tenantId === args.where.tenantId && l.isActive).map((l) => ({ id: l.id })),
      ),
    },
    professionalLocation: {
      findMany: jest.fn(async () => [
        { professionalId: "ana", locationId: LOC_A, isPrimary: true },
        { professionalId: "bea", locationId: LOC_B, isPrimary: true },
      ]),
    },
    appointment: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
    professional: { findMany: jest.fn(async () => []) },
    timeOff: { findMany: jest.fn(async () => []) },
    posSaleLine: { findMany: jest.fn(async () => []) },
  };
}

function setup(plan: string) {
  const prisma = makePrisma(plan);
  const subs = new SubscriptionsService(
    {} as any,
    { get: () => undefined } as any,
    { client: () => null, current: () => ({ taxEnabled: false }) } as any,
  );
  const flags = new AnalyticsFlagsService(new FeatureFlagService(prisma as any, subs));
  const service = new AnalyticsService(prisma as any);
  return { prisma, service, ctl: new AnalyticsController(service, flags) };
}

const req = { user: { id: "u1", tenantId: "t1", role: "owner", userId: "u1" } } as any;

describe("the overview by range and location", () => {
  beforeEach(() => jest.useFakeTimers().setSystemTime(new Date("2026-11-01T10:00:00Z")));
  afterEach(() => jest.useRealTimers());

  it("takes a named range, cut to the plan's months, and keeps months working", async () => {
    const { ctl } = setup("pro");
    const thisMonth = await ctl.getOverview(req, undefined, "last_30_days");
    expect(thisMonth.period).toEqual({ start: "2026-10-03", end: "2026-11-01" });
    expect(thisMonth.previousPeriod).toEqual({ start: "2026-09-03", end: "2026-10-02" });
    expect(thisMonth.range).toBe("last_30_days");
    // Pro shows 6 months: 12 is cut.
    const year = await ctl.getOverview(req, undefined, "12_months");
    expect(year.period).toEqual({ start: "2026-06-01", end: "2026-11-01" });
    // The old parameter still works, with no range in the answer.
    const months = await ctl.getOverview(req, "3");
    expect(months.period).toEqual({ start: "2026-09-01", end: "2026-11-01" });
    expect(months.range).toBeNull();
    expect(months.location).toBeNull();
  });

  it("answers an unknown range with a 400 instead of showing this month", async () => {
    const { ctl } = setup("pro");
    await expect(ctl.getOverview(req, undefined, "forever")).rejects.toBeInstanceOf(BadRequestException);
    await expect(ctl.getProfessionalPerformance(req, "forever")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("cuts every figure to one location on Empresa", async () => {
    const { ctl, prisma } = setup("empresa");
    const overview = await ctl.getOverview(req, undefined, "this_month", LOC_A);

    expect(overview.location).toEqual({ id: LOC_A, name: "Centro" });
    // Appointments: booked at Centro, or by Ana (who works there) with no location.
    for (const [args] of prisma.appointment.findMany.mock.calls as any[]) {
      expect(args.where).toMatchObject({
        tenantId: "t1",
        OR: [{ locationId: LOC_A }, { locationId: null, professionalId: { in: ["ana"] } }],
      });
    }
    // Occupancy: Centro's professionals only.
    expect((prisma.professional.findMany.mock.calls as any[])[0][0].where).toMatchObject({
      tenantId: "t1",
      isActive: true,
      id: { in: ["ana"] },
    });
    // The till: Ana's services, no products.
    expect((prisma.posSaleLine.findMany.mock.calls as any[])[0][0].where).toMatchObject({
      tenantId: "t1",
      kind: "service",
      professionalId: { in: ["ana"] },
    });
  });

  it("the location filter reaches the rates, the status charts and the Pro tabs", async () => {
    const { ctl, prisma } = setup("empresa");
    await ctl.getAppointmentRates(req, undefined, "3", LOC_B);
    await ctl.getAppointmentStatusByDays(req, "7", LOC_B);
    await ctl.getAppointmentStatusesEvolution(req, "3", LOC_B);
    await ctl.getProfessionalPerformance(req, "this_month", LOC_B);
    await ctl.getClientInsights(req, undefined, "last_month", LOC_B);
    const calls = [...prisma.appointment.findMany.mock.calls, ...prisma.appointment.count.mock.calls] as any[];
    // Every appointment query but servedBefore (a client who came to the salon before is not new).
    const scoped = calls.filter(([args]) => !args.distinct);
    expect(scoped.length).toBeGreaterThanOrEqual(6);
    for (const [args] of scoped) {
      expect(args.where.OR).toEqual([{ locationId: LOC_B }, { locationId: null, professionalId: { in: ["bea"] } }]);
    }
  });

  it("refuses another salon's location with a 404, without reading its figures", async () => {
    const { ctl, prisma } = setup("empresa");
    await expect(ctl.getOverview(req, undefined, "this_month", OTHER_SALON_LOC)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect((prisma.location.findFirst.mock.calls as any[])[0][0].where).toEqual({ id: OTHER_SALON_LOC, tenantId: "t1" });
    expect(prisma.appointment.findMany).not.toHaveBeenCalled();
    await expect(ctl.getClientInsights(req, "3", undefined, OTHER_SALON_LOC)).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctl.getAppointmentRates(req, "7", undefined, OTHER_SALON_LOC)).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctl.getProfessionalPerformance(req, undefined, OTHER_SALON_LOC)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it("answers a malformed id with a 400 and a plan without per-location reports with a 403", async () => {
    await expect(setup("empresa").ctl.getOverview(req, undefined, undefined, "centro")).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const pro = setup("pro");
    await expect(pro.ctl.getOverview(req, undefined, undefined, LOC_A)).rejects.toBeInstanceOf(ForbiddenException);
    expect(pro.prisma.location.findFirst).not.toHaveBeenCalled();
  });
});
