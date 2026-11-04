import { BadRequestException } from "@nestjs/common";
import {
  consoleMonths,
  monthLifecycle,
  paidChurnRate,
  parseMonthsParam,
  percentChange,
  PAYING_TENANT_WHERE,
  PLATFORM_TENANT_WHERE,
  scheduledInMonth,
} from "./platform-metrics";
import { SaasAnalyticsService } from "./saas-analytics.service";

/**
 * Audit 8 D4, D5, D12: the console's churn counted every cancelled salon of
 * all time (and by `updatedAt`), mixed expired trials with paying salons
 * that left, MRR counted salons with no Stripe subscription, months began at
 * UTC midnight and `?months=abc` was a 500.
 */
describe("platform metrics", () => {
  describe("parseMonthsParam", () => {
    it("defaults to 6 and clamps to 1..24", () => {
      expect(parseMonthsParam(undefined)).toBe(6);
      expect(parseMonthsParam("12")).toBe(12);
      expect(parseMonthsParam("5000")).toBe(24);
      expect(parseMonthsParam("0")).toBe(1);
    });
    it("rejects anything that is not a whole number", () => {
      for (const bad of ["abc", "-3", "2.5", "1e3"]) {
        expect(() => parseMonthsParam(bad)).toThrow(BadRequestException);
      }
    });
  });

  describe("consoleMonths", () => {
    it("starts months at Madrid midnight, not UTC", () => {
      // 1 Nov 2026 00:30 in Madrid is still 31 Oct in UTC.
      const now = new Date("2026-10-31T23:30:00Z");
      const [prev, cur] = consoleMonths(2, now);
      expect(cur.month).toBe("2026-11");
      expect(cur.start.toISOString()).toBe("2026-10-31T23:00:00.000Z");
      expect(prev.month).toBe("2026-10");
      // October starts in summer time (UTC+2).
      expect(prev.start.toISOString()).toBe("2026-09-30T22:00:00.000Z");
      expect(prev.end).toEqual(cur.start);
    });
    it("crosses the year", () => {
      const months = consoleMonths(3, new Date("2027-01-15T12:00:00Z")).map((m) => m.month);
      expect(months).toEqual(["2026-11", "2026-12", "2027-01"]);
    });
    it("filters visit days by calendar day", () => {
      const [m] = consoleMonths(1, new Date("2026-11-04T10:00:00Z"));
      expect(scheduledInMonth(m)).toEqual({
        gte: new Date("2026-11-01T00:00:00.000Z"),
        lt: new Date("2026-12-01T00:00:00.000Z"),
      });
    });
  });

  describe("monthLifecycle", () => {
    const now = new Date("2026-11-20T12:00:00Z");
    const [, nov] = consoleMonths(2, now);
    const d = (s: string) => new Date(s);
    const base = { createdAt: d("2026-01-01"), cancelledAt: null, firstPaidAt: null, trialEnd: null };

    it("tells paid cancellations from expired trials, by cancelledAt in the month", () => {
      const r = monthLifecycle(
        [
          { ...base, cancelledAt: d("2026-11-05"), firstPaidAt: d("2026-03-01") }, // paid, left
          { ...base, cancelledAt: d("2026-11-06") }, // never paid
          { ...base, cancelledAt: d("2026-10-06"), firstPaidAt: d("2026-03-01") }, // last month
        ],
        nov,
        now,
      );
      expect(r.paidCancellations).toBe(1);
      expect(r.expiredTrials).toBe(1);
    });

    it("computes trial-to-paid conversion over trials that ended in the month", () => {
      const r = monthLifecycle(
        [
          { ...base, trialEnd: d("2026-11-03"), firstPaidAt: d("2026-11-03") },
          { ...base, trialEnd: d("2026-11-10") },
          { ...base, trialEnd: d("2026-11-10"), cancelledAt: d("2026-11-10") },
          { ...base, trialEnd: d("2026-11-28") }, // still running
        ],
        nov,
        now,
      );
      expect(r.trialsEnded).toBe(3);
      expect(r.trialsConverted).toBe(1);
      expect(r.trialConversionRate).toBe(33.33);
    });

    it("has no conversion rate without a trial ending", () => {
      expect(monthLifecycle([], nov, now).trialConversionRate).toBeNull();
    });
  });

  it("compares with the previous month or says there is nothing to compare", () => {
    expect(percentChange(15, 10)).toBe(50);
    expect(percentChange(3, 0)).toBeNull();
    expect(paidChurnRate(1, 9)).toBe(10);
    expect(paidChurnRate(0, 0)).toBeNull();
  });

  it("keeps test salons and unbilled active salons out of MRR", () => {
    expect(PLATFORM_TENANT_WHERE).toEqual({ deletedAt: null, NOT: { slug: { startsWith: "zz-" } } });
    expect(PAYING_TENANT_WHERE).toMatchObject({
      subscriptionStatus: "active",
      stripeSubscriptionId: { not: null },
    });
  });
});

describe("SaasAnalyticsService", () => {
  it("reports takings in euros, MRR from paying salons only, and past_due / suspended", async () => {
    const prisma: any = {
      tenant: {
        count: jest.fn().mockResolvedValue(4),
        findMany: jest
          .fn()
          // paying salons
          .mockResolvedValueOnce([{ plan: "esencial", maxLocations: 1, tenantAddOns: [] }])
          // lifecycle rows
          .mockResolvedValueOnce([]),
        groupBy: jest
          .fn()
          .mockResolvedValueOnce([
            { subscriptionStatus: "active", _count: 2 },
            { subscriptionStatus: "past_due", _count: 1 },
            { subscriptionStatus: "suspended", _count: 1 },
          ])
          .mockResolvedValueOnce([{ country: "ES", _count: 4 }])
          .mockResolvedValueOnce([{ plan: "esencial", _count: 4 }]),
      },
      user: { count: jest.fn().mockResolvedValue(3) },
      client: { count: jest.fn().mockResolvedValue(10) },
      appointment: {
        count: jest.fn().mockResolvedValue(20),
        aggregate: jest.fn().mockResolvedValue({ _sum: { price: 12345 } }),
      },
    };
    const svc = new SaasAnalyticsService(prisma);
    const out = await svc.getPlatformAnalytics(new Date("2026-11-04T10:00:00Z"));

    expect(out.salonTakingsTotal).toBe(12345);
    expect(out.mrr).toBe(49);
    expect(out.arr).toBe(588);
    expect(out.payingTenants).toBe(1);
    expect(out.activeWithoutBilling).toBe(1);
    expect(out.pastDueTenants).toBe(1);
    expect(out.suspendedTenants).toBe(1);
    expect(prisma.tenant.findMany.mock.calls[0][0].where).toMatchObject({ stripeSubscriptionId: { not: null } });
    expect(prisma.appointment.aggregate.mock.calls[0][0].where).toMatchObject({ isTest: false, paymentStatus: "paid" });
  });
});
