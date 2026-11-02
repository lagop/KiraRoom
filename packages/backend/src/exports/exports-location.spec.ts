/**
 * Exports by location (Empresa): Analítica's export menu downloads the
 * period's appointments and payments; with a location chosen, they used to be
 * the whole salon's. GET /exports/appointments.(csv|xlsx) and
 * /exports/payments.(csv|xlsx) take an optional `locationId`, by Analítica's
 * rules (analytics-location.ts) and gate (consolidated_reports): 400
 * malformed, 403 on another plan, 404 for another salon's location, all
 * before the file starts.
 */
import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { ExportsController } from "./exports.controller";
import { ExportsService, paymentsExportWhere } from "./exports.service";
import { AnalyticsFlagsService } from "../analytics/analytics-flags.service";
import { AnalyticsService } from "../analytics/analytics.service";
import { FeatureFlagService } from "../common/feature-flags/feature-flag.service";
import { SubscriptionsService } from "../payments/services/subscriptions.service";

const LOC_A = "11111111-1111-4111-8111-111111111111";
const LOC_B = "22222222-2222-4222-8222-222222222222";
const OTHER_SALON_LOC = "33333333-3333-4333-8333-333333333333";
const SCOPE_A = [{ locationId: LOC_A }, { locationId: null, professionalId: { in: ["ana"] } }];

function makePrisma(plan: string) {
  const locations = [
    { id: LOC_A, tenantId: "t1", name: "Centro", isActive: true },
    { id: LOC_B, tenantId: "t1", name: "Norte", isActive: true },
    { id: OTHER_SALON_LOC, tenantId: "t2", name: "Otro salón", isActive: true },
  ];
  return {
    tenant: {
      findUnique: jest.fn(async (args: any) =>
        args.select?.timezone && Object.keys(args.select).length === 1
          ? { timezone: "Europe/Madrid" }
          : {
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
            },
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
    appointment: { findMany: jest.fn(async () => []) },
    payment: { findMany: jest.fn(async () => []) },
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
  const ctl = new ExportsController(new ExportsService(prisma as any), new AnalyticsService(prisma as any), flags);
  return { prisma, ctl };
}

function res(): any {
  return {
    headers: {} as Record<string, string>,
    chunks: [] as string[],
    write(chunk: any) {
      this.chunks.push(String(chunk));
      return true;
    },
    end() {
      this.ended = true;
    },
    setHeader(k: string, v: string) {
      this.headers[k] = v;
    },
  };
}

const req = { user: { id: "u1", tenantId: "t1", role: "owner" } } as any;

describe("exports by location (Empresa)", () => {
  it("the appointments of one location: booked there, or with none and a professional who works there", async () => {
    const { ctl, prisma } = setup("empresa");
    const out = res();
    await ctl.appointmentsCsv(req, out, { dateFrom: "2026-10-01", dateTo: "2026-10-31", locationId: LOC_A });
    const where = (prisma.appointment.findMany.mock.calls as any[])[0][0].where;
    expect(where).toMatchObject({ tenantId: "t1", OR: SCOPE_A });
    expect(where.scheduledDate).toBeDefined();
    expect(out.ended).toBe(true);
  });

  it("the payments of one location: those of its appointments, nothing of the till it cannot place", async () => {
    const { ctl, prisma } = setup("empresa");
    await ctl.paymentsCsv(req, res(), { status: "paid" as any, dateFrom: "2026-10-01", locationId: LOC_A });
    const where = (prisma.payment.findMany.mock.calls as any[])[0][0].where;
    expect(where.AND).toHaveLength(2);
    expect(where.AND[0]).toMatchObject({ tenantId: "t1", status: "paid" });
    expect(where.AND[1]).toEqual({ appointment: { is: { OR: SCOPE_A } } });
  });

  it("without a location: the whole salon, as before", async () => {
    const { ctl, prisma } = setup("pro");
    await ctl.appointmentsCsv(req, res(), {});
    await ctl.paymentsCsv(req, res(), {});
    expect((prisma.appointment.findMany.mock.calls as any[])[0][0].where).toEqual({ tenantId: "t1" });
    const where = (prisma.payment.findMany.mock.calls as any[])[0][0].where;
    expect(where.AND).toBeUndefined();
    expect(where.tenantId).toBe("t1");
    expect(prisma.location.findFirst).not.toHaveBeenCalled();
  });

  it("refuses another salon's location with a 404, before reading or writing anything", async () => {
    const { ctl, prisma } = setup("empresa");
    const out = res();
    await expect(ctl.appointmentsCsv(req, out, { locationId: OTHER_SALON_LOC })).rejects.toBeInstanceOf(NotFoundException);
    await expect(ctl.paymentsXlsx(req, out, { locationId: OTHER_SALON_LOC })).rejects.toBeInstanceOf(NotFoundException);
    expect((prisma.location.findFirst.mock.calls as any[])[0][0].where).toEqual({ id: OTHER_SALON_LOC, tenantId: "t1" });
    expect(prisma.appointment.findMany).not.toHaveBeenCalled();
    expect(prisma.payment.findMany).not.toHaveBeenCalled();
    expect(out.chunks).toEqual([]);
    expect(out.headers).toEqual({});
  });

  it("a 400 for a malformed id, a 403 on a plan without per-location reports", async () => {
    await expect(setup("empresa").ctl.paymentsCsv(req, res(), { locationId: "centro" })).rejects.toBeInstanceOf(
      BadRequestException,
    );
    const pro = setup("pro");
    await expect(pro.ctl.appointmentsCsv(req, res(), { locationId: LOC_A })).rejects.toBeInstanceOf(ForbiddenException);
    await expect(pro.ctl.paymentsCsv(req, res(), { locationId: LOC_A })).rejects.toMatchObject({
      response: { code: "FEATURE_NOT_IN_PLAN", message: "Exportar por local está disponible en el plan Empresa." },
    });
    expect(pro.prisma.location.findFirst).not.toHaveBeenCalled();
    expect(pro.prisma.payment.findMany).not.toHaveBeenCalled();
  });

  it("paymentsExportWhere leaves the filter as it is without a scope", () => {
    const where = { tenantId: "t1" };
    expect(paymentsExportWhere(where)).toBe(where);
  });
});
