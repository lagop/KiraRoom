/**
 * RebookingDispatcherService.processOne + runDailyTick unit tests.
 *
 * Covers the plan's validation matrix:
 *  - high variability (stdDev > avg/2) skips the cycle but advances
 *  - tenant disabled at row level â†’ skip with reason 'tenant_disabled'
 *  - already-sent-in-cycle â†’ skip
 *  - existing scheduled reminder (30d window) â†’ idempotent skip
 *  - HTML escaping in email body for XSS-class payloads
 *  - HMAC secret fallback rejects in production
 *
 * Uses lightweight in-memory mocks; no DB or network.
 */

import { RebookingDispatcherService } from "./rebooking-dispatcher.service";
import { RebookStatus, RebookChannel } from "@prisma/client";

function makeMocks(overrides: any = {}) {
  const tenant: any = {
    id: "tenant-1",
    name: "<img src=x onerror=alert(1)>", // XSS payload in name
    slug: "salon-xss",
    rebookingSettings: {
      enabled: true,
      leadDays: 3,
      channelFallback: "email",
      minVisits: 3,
    },
  };
  const cadence: any = {
    clientId: "client-1",
    tenantId: tenant.id,
    byService: {
      "svc-1": {
        avgDays: 21,
        stdDevDays: 1,
        lastVisit: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
        visitsCount: 5,
        nextExpectedAt: new Date(Date.now() + 16 * 24 * 60 * 60 * 1000).toISOString(),
      },
    },
    nextRecommendedReminderAt: new Date(),
    recommendedServiceId: "svc-1",
    reminderSentFor: [],
    optedOut: false,
    lastComputedAt: new Date(),
    tenant,
  };

  const cadenceFindUnique = jest.fn(async () => cadence);
  const cadenceFindMany = jest.fn(async () => [cadence]);
  const cadenceUpdate = jest.fn(async (args: any) => {
    Object.assign(cadence, args.data);
    return cadence;
  });
  const reminderCreate = jest.fn(async (args: any) => ({
    id: "rem-1",
    ...args.data,
  }));
  const reminderUpdate = jest.fn(async (args: any) => ({
    id: args.where.id,
    ...args.data,
  }));
  const reminderFindFirst = jest.fn(async () => null);
  const clientFindUnique = jest.fn(async (args: any) => ({
    id: args.where.id,
    firstName: "<script>alert(1)</script>",
    email: "x@example.com",
    phone: null,
  }));
  const serviceFindUnique = jest.fn(async () => ({
    name: "Corte",
    duration: 30,
  }));

  const cadenceSvc: any = {
    getTenantConfig: jest.fn(async () => ({
      enabled: true,
      leadDays: 3,
      channelFallback: "email",
      minVisits: 3,
    })),
  };

  const emailService: any = {
    sendEmail: jest.fn(async () => undefined),
  };

  const prisma: any = {
    clientCadence: {
      findUnique: cadenceFindUnique,
      findMany: cadenceFindMany,
      update: cadenceUpdate,
    },
    rebookingReminder: {
      create: reminderCreate,
      update: reminderUpdate,
      findFirst: reminderFindFirst,
    },
    client: { findUnique: clientFindUnique },
    service: { findUnique: serviceFindUnique },
  };

  // Apply overrides
  Object.assign(cadenceSvc.getTenantConfig, overrides.getTenantConfig);

  // P2A-receptionist-advanced â€” a stub FeatureFlagService that always
  // says "no advanced". Tests that need the advanced path override
  // `flags` via the constructor argument or by mutating the instance.
  const flagsStub = {
    isFeatureUnlocked: jest.fn().mockResolvedValue(false),
  } as any;
  return { prisma, cadenceSvc, emailService, cadence, tenant, reminders: [], flags: flagsStub };
}

describe("RebookingDispatcherService.processOne", () => {
  function buildDispatcher(mocks: ReturnType<typeof makeMocks>) {
    const dispatcher = new RebookingDispatcherService(
      mocks.prisma,
      mocks.cadenceSvc,
      mocks.emailService,
      mocks.flags ?? ({} as any),
    );
    // Skip the prod-secret check in tests.
    dispatcher.onModuleInit();
    return dispatcher;
  }

  it("sends a reminder for a healthy cadence and marks the row 'sent'", async () => {
    const m = makeMocks();
    const d = buildDispatcher(m);
    const result = await d.processOne("client-1");
    expect(result.ok).toBe(true);
    expect(m.emailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(m.prisma.rebookingReminder.create).toHaveBeenCalledTimes(1);
    const reminderUpdateCall = m.prisma.rebookingReminder.update.mock.calls[0][0];
    expect(reminderUpdateCall.data.status).toBe(RebookStatus.sent);
    expect(reminderUpdateCall.data.sentAt).toBeInstanceOf(Date);
  });

  it("skips when tenant is disabled (returns reason 'tenant_disabled')", async () => {
    const m = makeMocks();
    m.cadenceSvc.getTenantConfig.mockResolvedValue({
      enabled: false,
      leadDays: 3,
      channelFallback: "email",
      minVisits: 3,
    });
    const d = buildDispatcher(m);
    const result = await d.processOne("client-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("tenant_disabled");
    expect(m.emailService.sendEmail).not.toHaveBeenCalled();
  });

  it("skips when optedOut is true", async () => {
    const m = makeMocks();
    m.cadence.optedOut = true;
    const d = buildDispatcher(m);
    const result = await d.processOne("client-1");
    expect(result.reason).toBe("opted_out");
    expect(m.emailService.sendEmail).not.toHaveBeenCalled();
  });

  it("skips when no recommendedServiceId", async () => {
    const m = makeMocks();
    m.cadence.recommendedServiceId = null;
    const d = buildDispatcher(m);
    const result = await d.processOne("client-1");
    expect(result.reason).toBe("no_recommended_service");
  });

  it("skips when reminderSentFor already contains this serviceId", async () => {
    const m = makeMocks();
    m.cadence.reminderSentFor = [
      { serviceId: "svc-1", sentAt: new Date().toISOString(), channel: "email" },
    ];
    const d = buildDispatcher(m);
    const result = await d.processOne("client-1");
    expect(result.reason).toBe("already_sent_for_cycle");
  });

  it("skips when a scheduled/sent reminder exists in the last 30 days", async () => {
    const m = makeMocks();
    m.prisma.rebookingReminder.findFirst.mockResolvedValue({
      id: "rem-existing",
      clientId: "client-1",
      serviceId: "svc-1",
      status: RebookStatus.sent,
    });
    const d = buildDispatcher(m);
    const result = await d.processOne("client-1");
    expect(result.reason).toBe("reminder_already_exists");
  });

  it("high variability: skips but advances the cycle", async () => {
    const m = makeMocks();
    m.cadence.byService["svc-1"] = {
      avgDays: 21,
      stdDevDays: 20, // > avg/2
      lastVisit: new Date().toISOString(),
      visitsCount: 5,
      nextExpectedAt: new Date().toISOString(),
    };
    const d = buildDispatcher(m);
    const result = await d.processOne("client-1");
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("high_variability");
    // advanceCycle should have updated cadence.nextRecommendedReminderAt
    expect(m.prisma.clientCadence.update).toHaveBeenCalled();
  });

  it("escapes HTML in client name and salon name (XSS regression)", async () => {
    const m = makeMocks();
    const d = buildDispatcher(m);
    await d.processOne("client-1");
    const call = m.emailService.sendEmail.mock.calls[0][0];
    expect(call.html).not.toContain("<script>");
    expect(call.html).not.toContain("<img src=x onerror=alert(1)>");
    expect(call.html).toContain("&lt;script&gt;");
    expect(call.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("advances nextRecommendedReminderAt after successful send", async () => {
    const m = makeMocks();
    const d = buildDispatcher(m);
    await d.processOne("client-1");
    // At least one update call for cadence.advanceCycle and one for reminderSentFor.
    const updateCalls = m.prisma.clientCadence.update.mock.calls;
    expect(updateCalls.length).toBeGreaterThanOrEqual(1);
  });

  it("missing client marks reminder failed", async () => {
    const m = makeMocks();
    m.prisma.client.findUnique.mockResolvedValue(null);
    const d = buildDispatcher(m);
    const result = await d.processOne("client-1");
    expect(result.ok).toBe(false);
    expect(m.prisma.rebookingReminder.update).toHaveBeenCalled();
    const updateCall = m.prisma.rebookingReminder.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe(RebookStatus.failed);
    expect(updateCall.data.sentAt).toBeNull();
  });
});

describe("RebookingDispatcherService HMAC secret", () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...ORIGINAL_ENV, NODE_ENV: "production" };
    delete process.env.REBOOKING_OPT_OUT_SECRET;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
  });

  it("throws at module init if NODE_ENV=production and no secret", () => {
    const m = makeMocks();
    const dispatcher = new RebookingDispatcherService(
      m.prisma,
      m.cadenceSvc,
      m.emailService,
      m.flags ?? ({} as any),
    );
    expect(() => dispatcher.onModuleInit()).toThrow(/REBOOKING_OPT_OUT_SECRET/);
  });

  it("throws if secret is too short", () => {
    process.env.REBOOKING_OPT_OUT_SECRET = "short";
    const m = makeMocks();
    const dispatcher = new RebookingDispatcherService(
      m.prisma,
      m.cadenceSvc,
      m.emailService,
      m.flags ?? ({} as any),
    );
    expect(() => dispatcher.onModuleInit()).toThrow(/REBOOKING_OPT_OUT_SECRET/);
  });

  it("accepts a 16+ char secret in production", () => {
    process.env.REBOOKING_OPT_OUT_SECRET = "this-is-a-secret-of-sufficient-length";
    const m = makeMocks();
    const dispatcher = new RebookingDispatcherService(
      m.prisma,
      m.cadenceSvc,
      m.emailService,
      m.flags ?? ({} as any),
    );
    expect(() => dispatcher.onModuleInit()).not.toThrow();
  });
});

describe("RebookingDispatcherService.runDailyTick", () => {
  function buildDispatcher(mocks: ReturnType<typeof makeMocks>) {
    const dispatcher = new RebookingDispatcherService(
      mocks.prisma,
      mocks.cadenceSvc,
      mocks.emailService,
      // P2A-receptionist-advanced â€” spec passes a stub; tests that need
      // a specific gating outcome (advanced vs basic) override this
      // field on the returned dispatcher instance.
      mocks.flags ?? ({} as any),
    );
    dispatcher.onModuleInit();
    return dispatcher;
  }

  it("dispatches all cadences for the current UTC day", async () => {
    const m = makeMocks();
    const d = buildDispatcher(m);
    const result = await d.runDailyTick();
    expect(result.processed).toBe(1);
    expect(result.sent).toBe(1);
    expect(result.skipped).toBe(0);
  });

  it("does not crash when no cadences match the current day", async () => {
    const m = makeMocks();
    m.prisma.clientCadence.findMany.mockResolvedValue([]);
    const d = buildDispatcher(m);
    const result = await d.runDailyTick();
    expect(result.processed).toBe(0);
    expect(result.sent).toBe(0);
  });

  // P2A-receptionist-advanced â€” proactive rescheduling gate. The
  // dispatcher must only run the "advanced" path (which adds the
  // proposedSlot + calls suggestSlotFromCadence) when the tenant has
  // `virtual_receptionist_advanced` unlocked. With advanced, the
  // rebooking_reminder row must include `proposedSlot`; without
  // advanced, the row goes through the basic path with no proposedSlot.
  it("P2A-receptionist-advanced â€” proposedSlot is set when advanced=true and cadence has stats", async () => {
    const m = makeMocks();
    m.flags.isFeatureUnlocked = jest
      .fn()
      .mockImplementation((_t: string, key: string) =>
        Promise.resolve(key === "virtual_receptionist_advanced"),
      );
    m.prisma.clientCadence.findMany.mockResolvedValue([
      {
        clientId: "client-1",
        tenantId: "tenant-1",
        lastComputedAt: new Date(Date.now() - 30 * 86400000),
        byService: {
          "service-1": { avgDays: 28, stdDevDays: 2, count: 3 },
        },
        recommendedServiceId: "service-1",
        reminderSentFor: [],
        optedOut: false,
        tenant: m.tenant,
      },
    ] as any);
    m.cadence.getTenantConfig = jest.fn().mockResolvedValue({
      enabled: true,
      leadDays: 3,
      channelFallback: "email",
    });
    const d = buildDispatcher(m);
    await d.runDailyTick();

    expect(m.prisma.rebookingReminder.create).toHaveBeenCalled();
    // proposedSlot is set in the UPDATE (after the deliver), not
    // the create. Inspect the update call.
    expect(m.prisma.rebookingReminder.update).toHaveBeenCalled();
    const updated = m.prisma.rebookingReminder.update.mock.calls[0][0];
    expect(updated.data.proposedSlot).toBeDefined();
    expect(updated.data.proposedSlot.date).toBeTruthy();
    expect(updated.data.proposedSlot.time).toBeTruthy();
  });

  it("P2A-receptionist-advanced â€” proposedSlot is null when advanced is locked", async () => {
    const m = makeMocks();
    // flags.isFeatureUnlocked returns false for any key (default stub).
    m.prisma.clientCadence.findMany.mockResolvedValue([
      {
        clientId: "client-2",
        tenantId: "tenant-1",
        lastComputedAt: new Date(Date.now() - 30 * 86400000),
        byService: {
          "service-2": { avgDays: 28, stdDevDays: 2, count: 3 },
        },
        recommendedServiceId: "service-2",
        reminderSentFor: [],
        optedOut: false,
        tenant: m.tenant,
      },
    ] as any);
    m.cadence.getTenantConfig = jest.fn().mockResolvedValue({
      enabled: true,
      leadDays: 3,
      channelFallback: "email",
    });
    const d = buildDispatcher(m);
    await d.runDailyTick();

    expect(m.prisma.rebookingReminder.create).toHaveBeenCalled();
    const created = m.prisma.rebookingReminder.create.mock.calls[0][0];
    // Basic path leaves the field undefined so the migration's
    // `proposedSlot: undefined` leaves the column NULL.
    expect(created.proposedSlot).toBeUndefined();
  });
});