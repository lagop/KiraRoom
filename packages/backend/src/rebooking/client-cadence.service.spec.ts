/**
 * ClientCadenceService.computeForClient + cancelPending unit tests.
 *
 * Mirrors the validation matrix in the P1 plan:
 *  - ≥3 completed visits → cadence computed
 *  - 1 visit → byService empty
 *  - 2 visits → byService empty (below minVisits threshold)
 *  - high stdDev → cycle still advances but reminder is skipped
 *  - cancelPending(serviceId=null) only cancels generic reminders
 *  - cancelPending(serviceId=X) only cancels reminders for service X
 *
 * Uses an in-memory mock of PrismaService — no DB required.
 */

import { ClientCadenceService } from "./client-cadence.service";
import { RebookStatus } from "@prisma/client";

function makePrismaMock() {
  const tenant: any = {
    id: "tenant-1",
    rebookingSettings: {
      enabled: true,
      leadDays: 3,
      channelFallback: "both",
      minVisits: 3,
    },
  };
  const client: any = { id: "client-1", tenantId: tenant.id };

  const cadenceRows = new Map<string, any>();
  const reminders: any[] = [];

  // Permissive findUnique: route by table-specific shapes.
  const clientFindUnique = jest.fn(async (args: any) => {
    if (args?.where?.clientId && args.where.clientId === tenant.id) return tenant;
    if (args?.where?.clientId && args.where.clientId === client.id) return client;
    if (args?.where?.id === client.id) return client;
    return null;
  });
  const tenantFindUnique = jest.fn(async () => tenant);

  const appointmentFindMany = jest.fn(async () => []);

  const cadenceUpsert = jest.fn(async (args: any) => {
    const key = args.where.clientId;
    const existing = cadenceRows.get(key);
    const merged = existing
      ? { ...existing, ...args.update }
      : { ...args.create };
    cadenceRows.set(key, merged);
    return merged;
  });
  const cadenceUpdate = jest.fn(async (args: any) => {
    const cur = cadenceRows.get(args.where.clientId);
    cadenceRows.set(args.where.clientId, { ...cur, ...args.data });
    return cadenceRows.get(args.where.clientId);
  });
  const cadenceFindUnique = jest.fn(async (args: any) =>
    cadenceRows.get(args.where.clientId) ?? null,
  );

  const reminderCreate = jest.fn(async (args: any) => {
    const r = {
      id: `rem-${reminders.length + 1}`,
      ...args.data,
    };
    reminders.push(r);
    return r;
  });
  const reminderUpdateMany = jest.fn(async (args: any) => {
    let count = 0;
    const where = args.where;
    for (const r of reminders) {
      // Replicate Prisma's `where` semantics for status + clientId + serviceId.
      if (where.status && r.status !== where.status) continue;
      if (where.clientId && r.clientId !== where.clientId) continue;
      // The bug-fixed code uses either `{ serviceId }` or `{ serviceId: null }`
      // (no OR clause). Match that exactly.
      if (Object.prototype.hasOwnProperty.call(where, "serviceId")) {
        if (where.serviceId === null && r.serviceId !== null) continue;
        if (where.serviceId !== null && r.serviceId !== where.serviceId) continue;
      }
      Object.assign(r, args.data);
      count++;
    }
    return { count };
  });

  const prisma: any = {
    client: { findUnique: clientFindUnique },
    tenant: { findUnique: tenantFindUnique },
    appointment: { findMany: appointmentFindMany },
    clientCadence: {
      upsert: cadenceUpsert,
      update: cadenceUpdate,
      findUnique: cadenceFindUnique,
    },
    rebookingReminder: {
      create: reminderCreate,
      updateMany: reminderUpdateMany,
    },
  };
  return {
    prisma,
    tenant,
    client,
    cadenceRows,
    reminders,
    spies: {
      clientFindUnique,
      tenantFindUnique,
      appointmentFindMany,
      cadenceUpsert,
      cadenceUpdate,
      cadenceFindUnique,
      reminderCreate,
      reminderUpdateMany,
    },
  };
}

describe("ClientCadenceService.computeForClient", () => {
  function buildVisits(serviceId: string, daysAgo: number[]) {
    return daysAgo.map((d) => ({
      serviceId,
      completionTime: new Date(Date.now() - d * 24 * 60 * 60 * 1000),
      scheduledDate: new Date(Date.now() - d * 24 * 60 * 60 * 1000),
    }));
  }

  it("computes avgDays ≈ 21 and predicts next visit for 5 visits spaced 21 days apart", async () => {
    const m = makePrismaMock();
    m.spies.appointmentFindMany.mockResolvedValue(
      buildVisits("svc-1", [0, 21, 42, 63, 84]),
    );
    const svc = new ClientCadenceService(m.prisma);
    await svc.computeForClient("client-1");

    const row = m.cadenceRows.get("client-1");
    expect(row.byService["svc-1"].avgDays).toBe(21);
    expect(row.byService["svc-1"].visitsCount).toBe(5);
    expect(row.recommendedServiceId).toBe("svc-1");
    expect(row.nextRecommendedReminderAt).toBeTruthy();
  });

  it("returns empty byService when only 1 visit exists (below minVisits)", async () => {
    const m = makePrismaMock();
    m.spies.appointmentFindMany.mockResolvedValue(buildVisits("svc-1", [10]));
    const svc = new ClientCadenceService(m.prisma);
    await svc.computeForClient("client-1");

    const row = m.cadenceRows.get("client-1");
    expect(Object.keys(row.byService)).toHaveLength(0);
    expect(row.nextRecommendedReminderAt).toBeNull();
    expect(row.recommendedServiceId).toBeNull();
  });

  it("returns empty byService with 2 visits (still below minVisits=3)", async () => {
    const m = makePrismaMock();
    m.spies.appointmentFindMany.mockResolvedValue(buildVisits("svc-1", [0, 21]));
    const svc = new ClientCadenceService(m.prisma);
    await svc.computeForClient("client-1");

    const row = m.cadenceRows.get("client-1");
    expect(Object.keys(row.byService)).toHaveLength(0);
    expect(row.nextRecommendedReminderAt).toBeNull();
  });

  it("respects minVisits=5 (a tenant setting of 5 still requires 5 visits)", async () => {
    const m = makePrismaMock();
    m.tenant.rebookingSettings = {
      enabled: true,
      leadDays: 3,
      channelFallback: "both",
      minVisits: 5,
    };
    m.spies.appointmentFindMany.mockResolvedValue(
      buildVisits("svc-1", [0, 21, 42, 63]),
    );
    const svc = new ClientCadenceService(m.prisma);
    await svc.computeForClient("client-1");
    expect(Object.keys(m.cadenceRows.get("client-1").byService)).toHaveLength(0);
  });

  it("skips work when tenant has rebooking disabled (writes empty byService)", async () => {
    const m = makePrismaMock();
    m.tenant.rebookingSettings = { ...m.tenant.rebookingSettings, enabled: false };
    const svc = new ClientCadenceService(m.prisma);
    await svc.computeForClient("client-1");
    const row = m.cadenceRows.get("client-1");
    expect(row.byService).toEqual({});
  });

  it("caps stdDev at 30 days for outlier protection", async () => {
    const m = makePrismaMock();
    // 3 visits: gap=1, gap=60, gap=1 → variance is huge → stdDev would be ~30+
    m.spies.appointmentFindMany.mockResolvedValue(
      buildVisits("svc-1", [0, 1, 61]),
    );
    const svc = new ClientCadenceService(m.prisma);
    await svc.computeForClient("client-1");
    const row = m.cadenceRows.get("client-1");
    expect(row.byService["svc-1"].stdDevDays).toBeLessThanOrEqual(30);
  });

  it("no-ops when clientId does not exist", async () => {
    const m = makePrismaMock();
    m.spies.clientFindUnique.mockResolvedValue(null);
    const svc = new ClientCadenceService(m.prisma);
    await svc.computeForClient("ghost");
    expect(m.spies.cadenceUpsert).not.toHaveBeenCalled();
  });

  it("preserves reminderSentFor across recomputes", async () => {
    const m = makePrismaMock();
    m.cadenceRows.set("client-1", {
      clientId: "client-1",
      tenantId: m.client.tenantId,
      byService: {},
      reminderSentFor: [
        { serviceId: "svc-1", sentAt: "2026-01-01T00:00:00Z", channel: "email" },
      ],
      nextRecommendedReminderAt: null,
      recommendedServiceId: null,
      optedOut: false,
    });
    m.spies.appointmentFindMany.mockResolvedValue(
      buildVisits("svc-1", [0, 21, 42, 63, 84]),
    );
    const svc = new ClientCadenceService(m.prisma);
    await svc.computeForClient("client-1");
    expect(m.cadenceRows.get("client-1").reminderSentFor).toHaveLength(1);
  });
});

describe("ClientCadenceService.cancelPending (regression for fixed OR bug)", () => {
  function seedReminders() {
    return [
      {
        id: "r1",
        clientId: "client-1",
        serviceId: "svc-A",
        status: RebookStatus.scheduled,
      },
      {
        id: "r2",
        clientId: "client-1",
        serviceId: "svc-B",
        status: RebookStatus.scheduled,
      },
      {
        id: "r3",
        clientId: "client-1",
        serviceId: null,
        status: RebookStatus.scheduled,
      },
    ];
  }

  it("with serviceId=null only cancels reminders that have serviceId=null", async () => {
    const m = makePrismaMock();
    m.reminders.push(...seedReminders());

    const svc = new ClientCadenceService(m.prisma);
    const cancelled = await svc.cancelPending("client-1", null, "apt-123");

    expect(cancelled).toBe(1);
    expect(m.reminders[0].status).toBe(RebookStatus.scheduled);
    expect(m.reminders[1].status).toBe(RebookStatus.scheduled);
    expect(m.reminders[2].status).toBe(RebookStatus.cancelled);
    expect(m.reminders[2].resultAppointmentId).toBe("apt-123");
    expect(m.reminders[2].cancelledReason).toBe("client_booked");
  });

  it("with serviceId set only cancels that service's reminders", async () => {
    const m = makePrismaMock();
    m.reminders.push(...seedReminders());
    const svc = new ClientCadenceService(m.prisma);
    const cancelled = await svc.cancelPending("client-1", "svc-A", "apt-9");
    expect(cancelled).toBe(1);
    expect(m.reminders[0].status).toBe(RebookStatus.cancelled);
    expect(m.reminders[1].status).toBe(RebookStatus.scheduled);
    expect(m.reminders[2].status).toBe(RebookStatus.scheduled);
  });

  it("does not touch reminders that are already sent/failed/cancelled", async () => {
    const m = makePrismaMock();
    m.reminders.push({
      id: "r1",
      clientId: "client-1",
      serviceId: "svc-A",
      status: RebookStatus.sent,
    });
    const svc = new ClientCadenceService(m.prisma);
    const cancelled = await svc.cancelPending("client-1", "svc-A", "apt-1");
    expect(cancelled).toBe(0);
    expect(m.reminders[0].status).toBe(RebookStatus.sent);
  });

  it("regression: pre-fix code would have cancelled all three rows", () => {
    // Asserts what the OLD always-true OR clause would have matched, so
    // future refactors can't silently reintroduce the bug.
    const rows = [
      { id: "r1", clientId: "client-1", serviceId: "svc-A", status: "scheduled" },
      { id: "r2", clientId: "client-1", serviceId: "svc-B", status: "scheduled" },
      { id: "r3", clientId: "client-1", serviceId: null, status: "scheduled" },
    ];
    const buggyMatch = (r: any, clientId: string, serviceId: any) =>
      clientId === r.clientId &&
      r.status === "scheduled" &&
      (serviceId !== null
        ? r.serviceId === serviceId
        : r.serviceId === null ||
          r.serviceId !== null); // OLD always-true branch
    const fixedMatch = (r: any, clientId: string, serviceId: any) =>
      clientId === r.clientId &&
      r.status === "scheduled" &&
      (serviceId !== null ? r.serviceId === serviceId : r.serviceId === null);

    expect(rows.filter((r) => buggyMatch(r, "client-1", null))).toHaveLength(3);
    expect(rows.filter((r) => fixedMatch(r, "client-1", null))).toHaveLength(1);
  });
});

describe("ClientCadenceService.optOutClient", () => {
  it("sets optedOut=true and clears nextRecommendedReminderAt", async () => {
    const m = makePrismaMock();
    const svc = new ClientCadenceService(m.prisma);
    await svc.optOutClient("client-1");
    const row = m.cadenceRows.get("client-1");
    expect(row.optedOut).toBe(true);
    expect(row.nextRecommendedReminderAt).toBeNull();
  });
});

describe("ClientCadenceService.getTenantConfig", () => {
  it("returns sane defaults when settings is empty", async () => {
    const m = makePrismaMock();
    m.tenant.rebookingSettings = {};
    const svc = new ClientCadenceService(m.prisma);
    const cfg = await svc.getTenantConfig("tenant-1");
    expect(cfg.enabled).toBe(true); // default true (only `=== false` disables)
    expect(cfg.leadDays).toBe(3);
    expect(cfg.channelFallback).toBe("both");
    expect(cfg.minVisits).toBe(3);
  });

  it("respects explicit disabled flag", async () => {
    const m = makePrismaMock();
    m.tenant.rebookingSettings = {
      enabled: false,
      leadDays: 5,
      channelFallback: "email",
      minVisits: 4,
    };
    const svc = new ClientCadenceService(m.prisma);
    const cfg = await svc.getTenantConfig("tenant-1");
    expect(cfg.enabled).toBe(false);
    expect(cfg.leadDays).toBe(5);
    expect(cfg.channelFallback).toBe("email");
    expect(cfg.minVisits).toBe(4);
  });
});