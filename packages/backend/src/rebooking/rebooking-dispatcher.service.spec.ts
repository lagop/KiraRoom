/**
 * RebookingDispatcherService.processOne + runDailyTick unit tests.
 *
 * Covers:
 *  - high variability (stdDev > avg/2) skips the cycle but advances
 *  - tenant disabled at row level -> skip with reason 'tenant_disabled'
 *  - already-sent-in-cycle -> skip
 *  - existing scheduled reminder -> idempotent skip
 *  - HTML escaping in the email body; the subject is plain text
 *  - commercial-communication rules: refusal, suppression list, client
 *    status, WhatsApp opt-in
 *  - the shared signed unsubscribe link (and no more dead opt-out link)
 *  - the atomic claim, sending hours and the overdue window
 *
 * Uses lightweight in-memory mocks; no DB or network.
 */

import { RebookingDispatcherService, OVERDUE_WINDOW_DAYS, CLAIM_LEASE_MS } from "./rebooking-dispatcher.service";
import { RebookStatus } from "@prisma/client";

const DAY = 24 * 60 * 60 * 1000;

function makeMocks() {
  const tenant: any = {
    id: "tenant-1",
    name: "<img src=x onerror=alert(1)>", // markup in the salon's name
    slug: "salon-xss",
    timezone: "Europe/Madrid",
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
        lastVisit: new Date(Date.now() - 5 * DAY).toISOString(),
        visitsCount: 5,
        nextExpectedAt: new Date(Date.now() + 16 * DAY).toISOString(),
      },
    },
    nextRecommendedReminderAt: new Date(),
    recommendedServiceId: "svc-1",
    reminderSentFor: [],
    optedOut: false,
    lastComputedAt: new Date(),
    tenant,
  };

  const cadenceUpdate = jest.fn(async (args: any) => {
    Object.assign(cadence, args.data);
    return cadence;
  });
  const client: any = {
    id: "client-1",
    firstName: "<script>alert(1)</script>",
    email: "x@example.com",
    phone: null,
    status: "active",
  };

  const cadenceSvc: any = {
    getTenantConfig: jest.fn(async () => ({
      enabled: true,
      leadDays: 3,
      channelFallback: "email",
      minVisits: 3,
    })),
  };

  const emailService: any = {
    sendEmail: jest.fn(async () => ({ success: true, id: "email-1" })),
  };

  // The client's appointments: `completed` answers "completed this service
  // since the last notice?", `upcoming` "already booked?".
  const visits = { completedSince: null as Date | null, upcoming: false };
  const appointmentFindFirst = jest.fn(async (args: any) => {
    if (args.where.status === "completed") {
      const since: Date = args.where.completionTime.gt;
      return visits.completedSince && visits.completedSince > since ? { id: "visit-1" } : null;
    }
    return visits.upcoming ? { id: "upcoming-1" } : null;
  });

  // Consent records of client-1: { purpose, accepts }.
  const consents: Array<{ purpose: string; accepts: boolean }> = [];
  const consentFindMany = jest.fn(async (args: any) =>
    consents
      .filter((c) => c.purpose === args.where.form.purpose)
      .map((c) => ({ clientId: "client-1", responses: { accepts: c.accepts } })),
  );

  const prisma: any = {
    clientCadence: {
      findUnique: jest.fn(async () => cadence),
      findMany: jest.fn(async () => []),
      update: cadenceUpdate,
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    rebookingReminder: {
      create: jest.fn(async (args: any) => ({ id: "rem-1", ...args.data })),
      update: jest.fn(async (args: any) => ({ id: args.where.id, ...args.data })),
      findFirst: jest.fn(async () => null),
      count: jest.fn(async () => 0),
    },
    appointment: { findFirst: appointmentFindFirst },
    client: { findUnique: jest.fn(async () => client) },
    service: { findUnique: jest.fn(async () => ({ name: "Corte & color", duration: 30 })) },
    consent: { findMany: consentFindMany },
  };

  const suppressed = new Set<string>();
  const suppressions: any = {
    suppressedAmong: jest.fn(async (_t: string, emails: string[]) =>
      new Set(emails.map((e) => e.toLowerCase()).filter((e) => suppressed.has(e))),
    ),
  };
  const unsubscribes: any = {
    link: jest.fn((target: { kind: string; id: string }) => ({
      pageUrl: `https://app.test/public/baja/signed-${target.id}`,
      headers: {
        "List-Unsubscribe": `<https://api.test/api/v1/public/email/unsubscribe/signed-${target.id}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    })),
  };

  // Stub FeatureFlagService: "no advanced" unless a test says otherwise.
  const flags: any = { isFeatureUnlocked: jest.fn().mockResolvedValue(false) };
  return { prisma, cadenceSvc, emailService, cadence, tenant, client, flags, visits, consents, suppressed, suppressions, unsubscribes };
}

function build(m: ReturnType<typeof makeMocks>) {
  return new RebookingDispatcherService(m.prisma, m.cadenceSvc, m.emailService, m.flags, m.suppressions, m.unsubscribes);
}

describe("RebookingDispatcherService.processOne", () => {
  it("sends a reminder for a healthy cadence and marks the row 'sent'", async () => {
    const m = makeMocks();
    const result = await build(m).processOne("client-1");
    expect(result.ok).toBe(true);
    expect(m.emailService.sendEmail).toHaveBeenCalledTimes(1);
    expect(m.prisma.rebookingReminder.create).toHaveBeenCalledTimes(1);
    const reminderUpdateCall = m.prisma.rebookingReminder.update.mock.calls[0][0];
    expect(reminderUpdateCall.data.status).toBe(RebookStatus.sent);
    expect(reminderUpdateCall.data.sentAt).toBeInstanceOf(Date);
  });

  it("skips when tenant is disabled (returns reason 'tenant_disabled')", async () => {
    const m = makeMocks();
    m.cadenceSvc.getTenantConfig.mockResolvedValue({ enabled: false, leadDays: 3, channelFallback: "email", minVisits: 3 });
    const result = await build(m).processOne("client-1");
    expect(result).toEqual({ ok: false, reason: "tenant_disabled" });
    expect(m.emailService.sendEmail).not.toHaveBeenCalled();
  });

  it("skips when optedOut is true", async () => {
    const m = makeMocks();
    m.cadence.optedOut = true;
    const result = await build(m).processOne("client-1");
    expect(result.reason).toBe("opted_out");
    expect(m.emailService.sendEmail).not.toHaveBeenCalled();
  });

  it("skips when no recommendedServiceId", async () => {
    const m = makeMocks();
    m.cadence.recommendedServiceId = null;
    const result = await build(m).processOne("client-1");
    expect(result.reason).toBe("no_recommended_service");
  });

  it("skips when reminderSentFor already contains this serviceId", async () => {
    const m = makeMocks();
    m.cadence.reminderSentFor = [{ serviceId: "svc-1", sentAt: new Date().toISOString(), channel: "email" }];
    const result = await build(m).processOne("client-1");
    expect(result.reason).toBe("already_sent_for_cycle");
  });

  it("skips when a scheduled/sent reminder exists with no completed visit since", async () => {
    const m = makeMocks();
    m.prisma.rebookingReminder.findFirst.mockResolvedValue({
      id: "rem-existing",
      clientId: "client-1",
      serviceId: "svc-1",
      status: RebookStatus.sent,
      sentAt: new Date(Date.now() - 5 * DAY),
      createdAt: new Date(Date.now() - 5 * DAY),
    });
    const result = await build(m).processOne("client-1");
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
    const result = await build(m).processOne("client-1");
    expect(result).toEqual({ ok: false, reason: "high_variability" });
    expect(m.prisma.clientCadence.update).toHaveBeenCalled();
  });

  it("escapes every value in the HTML; the subject is plain text", async () => {
    const m = makeMocks();
    await build(m).processOne("client-1");
    const call = m.emailService.sendEmail.mock.calls[0][0];
    expect(call.html).not.toContain("<script>");
    expect(call.html).not.toContain("<img src=x onerror=alert(1)>");
    expect(call.html).toContain("&lt;script&gt;");
    expect(call.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(call.html).toContain("Corte &amp; color");
    // The subject is not HTML: it used to show "&amp;" literally.
    expect(call.subject).toContain("Corte & color");
    expect(call.subject).not.toContain("&amp;");
  });

  it("carries the shared signed unsubscribe link and its one-click headers", async () => {
    const m = makeMocks();
    await build(m).processOne("client-1");
    const call = m.emailService.sendEmail.mock.calls[0][0];
    expect(m.unsubscribes.link).toHaveBeenCalledWith({ kind: "c", id: "client-1" });
    expect(call.html).toContain('href="https://app.test/public/baja/signed-client-1"');
    expect(call.html).not.toContain("/api/public/rebooking/opt-out");
    expect(call.headers).toEqual({
      "List-Unsubscribe": "<https://api.test/api/v1/public/email/unsubscribe/signed-client-1>",
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    });
  });

  it("advances nextRecommendedReminderAt after successful send", async () => {
    const m = makeMocks();
    await build(m).processOne("client-1");
    expect(m.prisma.clientCadence.update.mock.calls.length).toBeGreaterThanOrEqual(1);
  });

  it("missing client marks reminder failed", async () => {
    const m = makeMocks();
    m.prisma.client.findUnique.mockResolvedValue(null);
    const result = await build(m).processOne("client-1");
    expect(result.ok).toBe(false);
    const updateCall = m.prisma.rebookingReminder.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe(RebookStatus.failed);
    expect(updateCall.data.sentAt).toBeNull();
  });
});

describe("RebookingDispatcherService commercial-communication rules", () => {
  it("does not email a client who refused promotions, and moves on to the next cycle", async () => {
    const m = makeMocks();
    m.consents.push({ purpose: "marketing", accepts: false });
    const result = await build(m).processOne("client-1");
    expect(result).toEqual({ ok: false, reason: "marketing_refused" });
    expect(m.emailService.sendEmail).not.toHaveBeenCalled();
    expect(m.prisma.rebookingReminder.create).not.toHaveBeenCalled();
    expect(m.prisma.clientCadence.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ nextRecommendedReminderAt: expect.any(Date) }) }),
    );
  });

  it("emails a client who accepted (or has not chosen: existing-client exception)", async () => {
    const m = makeMocks();
    m.consents.push({ purpose: "marketing", accepts: true });
    expect((await build(m).processOne("client-1")).ok).toBe(true);
  });

  it("does not email an address on the salon's suppression list (bounce, complaint, unsubscribe)", async () => {
    const m = makeMocks();
    m.suppressed.add("x@example.com");
    const result = await build(m).processOne("client-1");
    expect(result).toEqual({ ok: false, reason: "email_suppressed" });
    expect(m.suppressions.suppressedAmong).toHaveBeenCalledWith("tenant-1", ["x@example.com"]);
    expect(m.emailService.sendEmail).not.toHaveBeenCalled();
  });

  it.each(["inactive", "blocked"])("does not email a client whose status is %s", async (status) => {
    const m = makeMocks();
    m.client.status = status;
    const result = await build(m).processOne("client-1");
    expect(result).toEqual({ ok: false, reason: "client_not_active" });
    expect(m.emailService.sendEmail).not.toHaveBeenCalled();
  });

  it("WhatsApp needs the client's explicit opt-in", async () => {
    const m = makeMocks();
    m.cadenceSvc.getTenantConfig.mockResolvedValue({ enabled: true, leadDays: 3, channelFallback: "whatsapp", minVisits: 3 });
    expect(await build(m).processOne("client-1")).toEqual({ ok: false, reason: "no_whatsapp_marketing_consent" });
    expect(m.prisma.rebookingReminder.create).not.toHaveBeenCalled();

    const n = makeMocks();
    n.cadenceSvc.getTenantConfig.mockResolvedValue({ enabled: true, leadDays: 3, channelFallback: "whatsapp", minVisits: 3 });
    n.consents.push({ purpose: "marketing_whatsapp", accepts: true });
    // Allowed; WhatsApp itself is not wired yet.
    expect(await build(n).processOne("client-1")).toEqual({ ok: false, reason: "whatsapp_not_wired" });
  });
});

describe("RebookingDispatcherService atomic claim", () => {
  it("claims the row before anything else, with a lease", async () => {
    const m = makeMocks();
    const before = Date.now();
    await build(m).processOne("client-1");
    const claim = m.prisma.clientCadence.updateMany.mock.calls[0][0];
    expect(claim.where.clientId).toBe("client-1");
    expect(claim.where.OR[0]).toEqual({ dispatchClaimedAt: null });
    const leaseEdge: Date = claim.where.OR[1].dispatchClaimedAt.lt;
    expect(Math.abs(leaseEdge.getTime() - (before - CLAIM_LEASE_MS))).toBeLessThan(5_000);
    expect(claim.data.dispatchClaimedAt).toBeInstanceOf(Date);
  });

  it("does nothing when another tick or instance holds the row", async () => {
    const m = makeMocks();
    m.prisma.clientCadence.updateMany.mockResolvedValue({ count: 0 });
    const result = await build(m).processOne("client-1");
    expect(result).toEqual({ ok: false, reason: "claimed_elsewhere" });
    expect(m.prisma.clientCadence.findUnique).not.toHaveBeenCalled();
    expect(m.emailService.sendEmail).not.toHaveBeenCalled();
  });

  it("two overlapping runs send one email", async () => {
    const m = makeMocks();
    let held = false;
    m.prisma.clientCadence.updateMany.mockImplementation(async () => {
      if (held) return { count: 0 };
      held = true;
      return { count: 1 };
    });
    const d = build(m);
    await Promise.all([d.processOne("client-1"), d.processOne("client-1")]);
    expect(m.emailService.sendEmail).toHaveBeenCalledTimes(1);
  });
});

describe("RebookingDispatcherService suggested date", () => {
  function localDay(at: Date) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(at);
  }

  it("never proposes a day gone by, even for a client well past her cycle", async () => {
    const m = makeMocks();
    m.cadence.byService["svc-1"].lastVisit = new Date(Date.now() - 60 * DAY).toISOString(); // due 39 days ago
    await build(m).processOne("client-1", { hasAdvanced: true });
    const slot = m.prisma.rebookingReminder.update.mock.calls[0][0].data.proposedSlot;
    expect(slot.date >= localDay(new Date(Date.now() + DAY))).toBe(true);
    expect(slot.time).toBe("18:30");
  });

  it("proposes her usual cycle when it is still ahead", async () => {
    const m = makeMocks();
    m.cadence.byService["svc-1"].lastVisit = new Date(Date.now() - 10 * DAY).toISOString();
    await build(m).processOne("client-1", { hasAdvanced: true });
    const slot = m.prisma.rebookingReminder.update.mock.calls[0][0].data.proposedSlot;
    expect(slot.date).toBe(localDay(new Date(Date.now() + 11 * DAY)));
    const html: string = m.emailService.sendEmail.mock.calls[0][0].html;
    expect(html).toMatch(/Hace 10 días que no te vemos/);
  });

  it("basic mode proposes three days ahead and stores no slot", async () => {
    const m = makeMocks();
    await build(m).processOne("client-1", { hasAdvanced: false });
    expect(m.prisma.rebookingReminder.update.mock.calls[0][0].data.proposedSlot).toBeUndefined();
    const expected = new Date(Date.now() + 3 * DAY).toLocaleDateString("es-ES", {
      weekday: "long",
      day: "numeric",
      month: "long",
      timeZone: "Europe/Madrid",
    });
    expect(m.emailService.sendEmail.mock.calls[0][0].html).toContain(`el ${expected} a las 10:00`);
  });
});

describe("RebookingDispatcherService one notice per visit cycle", () => {
  it("is eligible again once the service was completed after the last notice", async () => {
    const m = makeMocks();
    m.cadence.reminderSentFor = [
      { serviceId: "svc-1", sentAt: new Date(Date.now() - 40 * DAY).toISOString(), channel: "email" },
    ];
    m.visits.completedSince = new Date(Date.now() - 20 * DAY);
    const result = await build(m).processOne("client-1");
    expect(result.ok).toBe(true);
    expect(m.emailService.sendEmail).toHaveBeenCalledTimes(1);
    // Only the latest notice per service is kept.
    const sentForUpdate = m.prisma.clientCadence.update.mock.calls.find((c: any) => c[0].data.reminderSentFor);
    expect(sentForUpdate[0].data.reminderSentFor).toHaveLength(1);
    expect(new Date(sentForUpdate[0].data.reminderSentFor[0].sentAt).getTime()).toBeGreaterThan(Date.now() - DAY);
  });

  it("is not eligible while the service has not been completed since the last notice", async () => {
    const m = makeMocks();
    m.cadence.reminderSentFor = [
      { serviceId: "svc-1", sentAt: new Date(Date.now() - 10 * DAY).toISOString(), channel: "email" },
    ];
    m.visits.completedSince = new Date(Date.now() - 20 * DAY); // before the notice
    const result = await build(m).processOne("client-1");
    expect(result.reason).toBe("already_sent_for_cycle");
    expect(m.emailService.sendEmail).not.toHaveBeenCalled();
  });

  it("an older reminder row stops blocking once she completed the service after it", async () => {
    const m = makeMocks();
    m.prisma.rebookingReminder.findFirst.mockResolvedValue({
      id: "rem-old",
      status: RebookStatus.sent,
      sentAt: new Date(Date.now() - 40 * DAY),
      createdAt: new Date(Date.now() - 40 * DAY),
    });
    m.visits.completedSince = new Date(Date.now() - 15 * DAY);
    const result = await build(m).processOne("client-1");
    expect(result.ok).toBe(true);
  });

  it("skips a client who already has an upcoming appointment", async () => {
    const m = makeMocks();
    m.visits.upcoming = true;
    const result = await build(m).processOne("client-1");
    expect(result).toEqual({ ok: false, reason: "has_upcoming_appointment" });
    expect(m.prisma.rebookingReminder.create).not.toHaveBeenCalled();
    expect(m.emailService.sendEmail).not.toHaveBeenCalled();
    const upcomingQuery = m.prisma.appointment.findFirst.mock.calls.find((c: any) => c[0].where.status?.in)[0].where;
    expect(upcomingQuery.status.in).toEqual(["pending", "confirmed"]);
    expect(upcomingQuery.clientId).toBe("client-1");
    expect(upcomingQuery.serviceId).toBeUndefined(); // any service
  });

  it("never emails a placeholder address, and does not retry it this cycle", async () => {
    const m = makeMocks();
    m.client.email = "wizard-1730000000000@placeholder.local";
    m.client.firstName = "Ana";
    const result = await build(m).processOne("client-1");
    expect(result).toEqual({ ok: false, reason: "no_email" });
    expect(m.emailService.sendEmail).not.toHaveBeenCalled();
    expect(m.prisma.rebookingReminder.update.mock.calls[0][0].data.status).toBe(RebookStatus.failed);
    // advanced to the next cycle rather than retried every hour today
    expect(m.prisma.clientCadence.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ nextRecommendedReminderAt: expect.any(Date) }) }),
    );
  });

  it("an email the provider refused is not counted as sent", async () => {
    const m = makeMocks();
    m.emailService.sendEmail.mockResolvedValue({ success: false, error: "rate_limited" });
    const result = await build(m).processOne("client-1");
    expect(result).toEqual({ ok: false, reason: "rate_limited" });
    expect(m.prisma.rebookingReminder.update.mock.calls[0][0].data.status).toBe(RebookStatus.failed);
    // left for the next hourly tick: the cycle is not used up
    expect(m.prisma.clientCadence.update).not.toHaveBeenCalled();
  });

  it("stops retrying after 3 failed sends in a day", async () => {
    const m = makeMocks();
    m.prisma.rebookingReminder.count.mockResolvedValue(3);
    const result = await build(m).processOne("client-1");
    expect(result.reason).toBe("too_many_failures");
    expect(m.emailService.sendEmail).not.toHaveBeenCalled();
  });
});

describe("RebookingDispatcherService.runDailyTick", () => {
  // 11:00 and 02:30 in Madrid (CET, UTC+1).
  const MORNING = new Date("2026-11-03T10:00:00Z");
  const NIGHT = new Date("2026-11-03T01:30:00Z");

  function row(clientId: string, dueAt: Date, timezone = "Europe/Madrid") {
    return { clientId, tenantId: "tenant-1", nextRecommendedReminderAt: dueAt, tenant: { timezone } };
  }

  it("sends the reminders due today in the salon's sending hours", async () => {
    const m = makeMocks();
    m.prisma.clientCadence.findMany.mockResolvedValue([row("client-1", new Date("2026-11-03T08:00:00Z"))]);
    const result = await build(m).runDailyTick(MORNING);
    expect(result).toEqual({ processed: 1, sent: 1, skipped: 0, deferred: 0 });
  });

  it("defers, does not skip, outside the sending hours", async () => {
    const m = makeMocks();
    m.prisma.clientCadence.findMany.mockResolvedValue([row("client-1", new Date("2026-11-02T23:30:00Z"))]);
    const result = await build(m).runDailyTick(NIGHT);
    expect(result).toEqual({ processed: 0, sent: 0, skipped: 0, deferred: 1 });
    expect(m.prisma.clientCadence.updateMany).not.toHaveBeenCalled();
    expect(m.emailService.sendEmail).not.toHaveBeenCalled();
  });

  it("picks up reminders from missed days, within the overdue window", async () => {
    const m = makeMocks();
    m.prisma.clientCadence.findMany.mockResolvedValue([row("client-1", new Date(MORNING.getTime() - 2 * DAY))]);
    const result = await build(m).runDailyTick(MORNING);
    expect(result.sent).toBe(1);
    const where = m.prisma.clientCadence.findMany.mock.calls[0][0].where;
    expect(where.nextRecommendedReminderAt.gte).toEqual(new Date(MORNING.getTime() - OVERDUE_WINDOW_DAYS * DAY));
    expect(where.optedOut).toBe(false);
    // rows another tick holds are not read again within the lease
    expect(where.OR).toEqual([
      { dispatchClaimedAt: null },
      { dispatchClaimedAt: { lt: new Date(MORNING.getTime() - CLAIM_LEASE_MS) } },
    ]);
  });

  it("leaves a reminder due tomorrow in the salon's time zone for tomorrow", async () => {
    const m = makeMocks();
    // 23:30 UTC on the 3rd is already the 4th in Madrid.
    m.prisma.clientCadence.findMany.mockResolvedValue([row("client-1", new Date("2026-11-03T23:30:00Z"))]);
    const result = await build(m).runDailyTick(MORNING);
    expect(result).toEqual({ processed: 0, sent: 0, skipped: 0, deferred: 0 });
  });

  it("does not crash when nothing is due", async () => {
    const m = makeMocks();
    const result = await build(m).runDailyTick(MORNING);
    expect(result.processed).toBe(0);
    expect(result.sent).toBe(0);
  });

  it("proposedSlot is set when advanced is unlocked and the cadence has stats", async () => {
    const m = makeMocks();
    m.flags.isFeatureUnlocked.mockImplementation((_t: string, key: string) =>
      Promise.resolve(key === "virtual_receptionist_advanced"),
    );
    m.prisma.clientCadence.findMany.mockResolvedValue([row("client-1", MORNING)]);
    await build(m).runDailyTick(MORNING);
    const updated = m.prisma.rebookingReminder.update.mock.calls[0][0];
    expect(updated.data.proposedSlot.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(updated.data.proposedSlot.time).toBe("18:30");
  });

  it("proposedSlot is not set when advanced is locked", async () => {
    const m = makeMocks();
    m.prisma.clientCadence.findMany.mockResolvedValue([row("client-1", MORNING)]);
    await build(m).runDailyTick(MORNING);
    expect(m.prisma.rebookingReminder.create).toHaveBeenCalled();
    expect(m.prisma.rebookingReminder.update.mock.calls[0][0].data.proposedSlot).toBeUndefined();
  });
});
