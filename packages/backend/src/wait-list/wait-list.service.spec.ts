import { BadRequestException, ConflictException } from "@nestjs/common";
import {
  WAIT_LIST_MAX_AGE_DAYS,
  WaitListService,
  isQuietHour,
  parseDay,
  parseWaitListLeaveToken,
  salonClock,
  staleReason,
  waitListLeaveToken,
} from "./wait-list.service";

/**
 * "Avisar" flipped the entry to "notified" and sent nothing; a cancelled
 * appointment did the same to every matching client. A notice now goes out
 * through the real channels, honours the client's opt-outs, and the entry is
 * only marked notified when something was actually delivered. When nothing
 * can deliver (no provider configured), the answer says so.
 */

/** A small evaluator for the Prisma `where` clauses the service builds. */
function matches(row: any, where: any): boolean {
  for (const [k, v] of Object.entries(where ?? {})) {
    if (k === "OR") {
      if (!(v as any[]).some((c) => matches(row, c))) return false;
      continue;
    }
    if (k === "AND") {
      if (!(v as any[]).every((c) => matches(row, c))) return false;
      continue;
    }
    const val = row[k];
    if (v === null) {
      if (val !== null && val !== undefined) return false;
      continue;
    }
    if (typeof v === "object" && !(v instanceof Date)) {
      const o: any = v;
      const ops = ["lt", "lte", "gte", "in", "not"].filter((op) => op in o);
      if (ops.length === 0) {
        if (!matches(val ?? {}, o)) return false; // relation filter
        continue;
      }
      if (o.in && !o.in.includes(val)) return false;
      if ("not" in o && val === o.not) return false;
      if (o.lt !== undefined && !(val != null && val < o.lt)) return false;
      if (o.lte !== undefined && !(val != null && val <= o.lte)) return false;
      if (o.gte !== undefined && !(val != null && val >= o.gte)) return false;
      continue;
    }
    if ((val ?? null) !== v) return false;
  }
  return true;
}

const D = (s: string) => new Date(`${s}T00:00:00.000Z`);
// 10:00 in Madrid on 2 Nov 2026 (UTC+1).
const MORNING = new Date("2026-11-02T09:00:00.000Z");

function setup(
  over: {
    client?: Record<string, any>;
    emailConfigured?: boolean;
    smsConfigured?: boolean;
    whatsapp?: { sent: boolean; reason?: string };
    autoNotify?: boolean;
    entries?: any[];
    prefs?: (channel: string) => boolean;
    service?: Record<string, any>;
    tenant?: Record<string, any>;
    now?: Date;
  } = {},
) {
  const entry = {
    id: "w1",
    tenantId: "t1",
    clientId: "c1",
    serviceId: "s1",
    professionalId: null,
    status: "waiting",
    earliestDate: null,
    latestDate: null,
    notifiedAt: null,
    createdAt: 1,
    client: {
      id: "c1",
      firstName: "Ana",
      lastName: "López",
      email: "ana@example.test",
      phone: "600111222",
      communicationPreferences: {},
      status: "active",
      ...over.client,
    },
  };
  const entries = over.entries ?? [entry];
  const prisma: any = {
    waitList: {
      findFirst: jest.fn(async ({ where }: any) => entries.find((e) => matches(e, where)) ?? null),
      findUnique: jest.fn(async ({ where }: any) => entries.find((e) => e.id === where.id) ?? null),
      findMany: jest.fn(async ({ where, take }: any) => {
        const out = entries.filter((e) => matches(e, where)).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
        return typeof take === "number" ? out.slice(0, take) : out;
      }),
      update: jest.fn(async ({ data }: any) => data),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = entries.filter((e) => matches(e, where));
        for (const e of hit) {
          if (data.status) e.status = data.status;
          if (data.notifiedAt) e.notifiedAt = data.notifiedAt;
          if (data.closedReason !== undefined) e.closedReason = data.closedReason;
        }
        return { count: hit.length };
      }),
      create: jest.fn(async ({ data }: any) => ({ id: "new", ...data })),
    },
    tenant: {
      findUnique: jest.fn(async () => ({
        name: "Salón Lucía",
        slug: "salon-lucia",
        country: "ES",
        phone: "910000000",
        timezone: "Europe/Madrid",
        customDomain: null,
        waitListAutoNotify: over.autoNotify ?? false,
        ...over.tenant,
      })),
      update: jest.fn(),
    },
    client: { findFirst: jest.fn(async () => ({ id: "c1" })) },
    service: {
      findFirst: jest.fn(async () => ({ id: "s1", name: "Corte", isOnlineBookable: true, isActive: true, ...over.service })),
      findMany: jest.fn(async () => [{ id: "s1", name: "Corte" }]),
    },
    professional: {
      findFirst: jest.fn(async () => ({ firstName: "Lu" })),
      findMany: jest.fn(async () => []),
    },
    user: { findMany: jest.fn(async () => [{ id: "u-owner" }]) },
    $executeRaw: jest.fn(async () => 1),
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  const flags: any = { isFeatureUnlocked: jest.fn(async () => true) };
  const notifications: any = {
    shouldSendNotification: jest.fn(async (_c: string, _t: string, ch: string) => (over.prefs ? over.prefs(ch) : true)),
    create: jest.fn(async () => ({ id: "n1" })),
  };
  const email: any = {
    isConfigured: () => over.emailConfigured ?? false,
    sendEmail: jest.fn(async () => ({ success: true, id: "e1" })),
  };
  const sms: any = {
    isConfigured: () => over.smsConfigured ?? false,
    sendSms: jest.fn(async () => ({ success: true, id: "sm1" })),
  };
  const whatsapp: any = {
    sendWaitlistSlot: jest.fn(async () => over.whatsapp ?? { sent: false, reason: "not_connected" }),
    canSend: jest.fn(async () => ({ ok: false, reason: "not_connected" })),
  };
  const service = new WaitListService(prisma, flags, notifications, email, sms, whatsapp);
  service.clock = () => over.now ?? MORNING;
  const managerNotes = () => notifications.create.mock.calls.map((c: any[]) => c[0]).filter((n: any) => n.userId);
  return { service, prisma, notifications, email, sms, whatsapp, managerNotes };
}

describe("WaitListService.notify (Avisar)", () => {
  it("with no provider configured, says so and does not pretend the client was told", async () => {
    const { service, prisma } = setup();
    const out = await service.notify("t1", "w1", { date: "2026-11-08", time: "10:30" }, "u1");

    expect(out.notified).toBe(false);
    expect(out.summary).toMatch(/no hay proveedor de email configurado/);
    expect(out.summary).toMatch(/no hay proveedor de SMS configurado/);
    const data = prisma.waitList.updateMany.mock.calls[0][0].data;
    expect(data.status).toBeUndefined();
    expect(data.lastNotification.channels.length).toBeGreaterThan(0);
  });

  it("sends the email with a link to book the freed slot and records the notice", async () => {
    const { service, prisma, email } = setup({ emailConfigured: true });
    const out = await service.notify("t1", "w1", { date: "2026-11-08", time: "10:30" }, "u1");

    expect(out.notified).toBe(true);
    expect(out.bookingUrl).toContain("/sites/salon-lucia?serviceId=s1");
    expect(out.bookingUrl).toContain("date=2026-11-08");
    const html = email.sendEmail.mock.calls[0][0].html as string;
    expect(html).toContain("10:30");
    expect(html).toContain("/sites/salon-lucia");
    const call = prisma.waitList.updateMany.mock.calls[0][0];
    expect(call.data).toMatchObject({ status: "notified", notifyCount: { increment: 1 } });
    expect(call.data.lastNotification).toMatchObject({ by: "u1", auto: false });
    // Only an entry still open is written.
    expect(call.where.status).toEqual({ in: ["waiting", "notified"] });
  });

  it("prefers the salon's WhatsApp and then does not also send an SMS", async () => {
    const { service, sms } = setup({ smsConfigured: true, whatsapp: { sent: true } });
    const out = await service.notify("t1", "w1");
    expect(out.notified).toBe(true);
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(out.channels.find((c) => c.channel === "sms")).toMatchObject({ status: "skipped" });
  });

  it("falls back to SMS when WhatsApp's template is not approved yet, and says why", async () => {
    const { service, sms } = setup({ smsConfigured: true, whatsapp: { sent: false, reason: "template_pending" } });
    const out = await service.notify("t1", "w1");
    expect(sms.sendSms).toHaveBeenCalledTimes(1);
    expect(out.channels.find((c) => c.channel === "whatsapp")?.reason).toMatch(/plantilla/);
  });

  it("respects a client who said STOP to WhatsApp and turned SMS off in their preferences", async () => {
    const { service, sms, whatsapp } = setup({
      smsConfigured: true,
      client: { communicationPreferences: { whatsapp: false } },
      prefs: (ch) => ch !== "sms",
    });
    const out = await service.notify("t1", "w1");
    expect(whatsapp.sendWaitlistSlot).not.toHaveBeenCalled();
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(out.notified).toBe(false);
  });

  it("refuses to notify a closed entry, and to fake the 'notified' status", async () => {
    const { service } = setup({
      entries: [{ id: "w1", tenantId: "t1", status: "fulfilled", client: {} }],
    });
    await expect(service.notify("t1", "w1")).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.update("t1", "w1", { status: "notified" })).rejects.toBeInstanceOf(BadRequestException);
  });

  it("does not reach another salon's entry", async () => {
    const { service } = setup();
    await expect(service.notify("t2", "w1")).rejects.toThrow(/no encontrada/);
  });

  it("does not notify a blocked client", async () => {
    const { service, email } = setup({ emailConfigured: true, client: { status: "blocked" } });
    await expect(service.notify("t1", "w1")).rejects.toThrow(/bloqueado/);
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it("refuses an impossible or past slot date with a 400, not a crash", async () => {
    const { service } = setup({ emailConfigured: true });
    await expect(service.notify("t1", "w1", { date: "2026-13-01" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.notify("t1", "w1", { date: "2026-02-30" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.notify("t1", "w1", { date: "2026-10-01" })).rejects.toThrow(/ya ha pasado/);
  });

  it("for a service not bookable online, asks the client to call instead of sending a link", async () => {
    const { service, email, sms } = setup({
      emailConfigured: true,
      smsConfigured: true,
      service: { isOnlineBookable: false },
    });
    const out = await service.notify("t1", "w1", { date: "2026-11-08" });
    expect(out.bookingUrl).toBeNull();
    const html = email.sendEmail.mock.calls[0][0].html as string;
    expect(html).not.toContain("/sites/");
    expect(html).toContain("llama al salón");
    expect(html).toContain("910000000");
    expect(sms.sendSms.mock.calls[0][0].body).toContain("llama al salón: 910000000");
  });

  it("links to the salon's own domain when it has one", async () => {
    const prev = process.env.CUSTOM_DOMAINS_TLS_READY;
    process.env.CUSTOM_DOMAINS_TLS_READY = "true";
    try {
      const { service } = setup({
        emailConfigured: true,
        tenant: { customDomain: { domain: "salonlucia.es", verifiedAt: new Date() } },
      });
      const out = await service.notify("t1", "w1", { date: "2026-11-08" });
      expect(out.bookingUrl).toBe("https://salonlucia.es/?serviceId=s1&date=2026-11-08");
    } finally {
      if (prev === undefined) delete process.env.CUSTOM_DOMAINS_TLS_READY;
      else process.env.CUSTOM_DOMAINS_TLS_READY = prev;
    }
  });

  it("treats a placeholder address as no email and keeps provider errors out of the panel", async () => {
    const placeholder = setup({ emailConfigured: true, client: { email: "wizard-1@placeholder.local", phone: null } });
    const a = await placeholder.service.notify("t1", "w1");
    expect(placeholder.email.sendEmail).not.toHaveBeenCalled();
    expect(a.channels.find((c) => c.channel === "email")?.reason).toBe("el cliente no tiene email");

    const failing = setup({ emailConfigured: true });
    failing.email.sendEmail.mockResolvedValueOnce({ success: false, error: "Invalid `to` field: provider 422" });
    const b = await failing.service.notify("t1", "w1");
    expect(b.channels.find((c) => c.channel === "email")?.reason).toBe("el proveedor de email no ha podido enviarlo");
  });
});

describe("WaitListService.add / update", () => {
  it("refuses a second active entry for the same client, service and professional", async () => {
    const { service, prisma } = setup();
    await expect(service.add("t1", { clientId: "c1", serviceId: "s1" })).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.$executeRaw).toHaveBeenCalled();
    expect(prisma.waitList.create).not.toHaveBeenCalled();
  });

  it("adds one when the earlier entry is closed", async () => {
    const { service, prisma } = setup({
      entries: [{ id: "w1", tenantId: "t1", clientId: "c1", serviceId: "s1", professionalId: null, status: "fulfilled" }],
    });
    await service.add("t1", { clientId: "c1", serviceId: "s1", earliestDate: "2026-11-05", latestDate: "2026-11-20" });
    expect(prisma.waitList.create.mock.calls[0][0].data).toMatchObject({
      earliestDate: D("2026-11-05"),
      latestDate: D("2026-11-20"),
      status: "waiting",
    });
  });

  it("validates the window: real dates, not past, 'hasta' not before 'desde'", async () => {
    const { service } = setup({ entries: [] });
    const base = { clientId: "c1", serviceId: "s1" };
    await expect(service.add("t1", { ...base, earliestDate: "2026-13-01" })).rejects.toThrow(/no es válida/);
    await expect(service.add("t1", { ...base, earliestDate: "2026-10-01" })).rejects.toThrow(/ya ha pasado/);
    await expect(
      service.add("t1", { ...base, earliestDate: "2026-11-10", latestDate: "2026-11-05" }),
    ).rejects.toThrow(/no puede ser anterior/);
    // Today (salon time) is fine.
    await expect(service.add("t1", { ...base, earliestDate: "2026-11-02" })).resolves.toBeDefined();
  });

  it("reopening a closed entry checks for an open duplicate", async () => {
    const { service } = setup({
      entries: [
        { id: "w1", tenantId: "t1", clientId: "c1", serviceId: "s1", professionalId: null, status: "cancelled" },
        { id: "w2", tenantId: "t1", clientId: "c1", serviceId: "s1", professionalId: null, status: "waiting" },
      ],
    });
    await expect(service.update("t1", "w1", { status: "waiting" })).rejects.toBeInstanceOf(ConflictException);
  });
});

describe("WaitListService.list", () => {
  const rows = () => [
    { id: "w1", tenantId: "t1", serviceId: "s1", professionalId: null, status: "waiting", createdAt: 1,
      client: { firstName: "Ana", lastName: "L", email: "ana@example.test", phone: "600111222" } },
    { id: "w2", tenantId: "t1", serviceId: "s1", professionalId: null, status: "waiting", createdAt: 2,
      client: { firstName: "Eva", lastName: "M", email: "x@placeholder.local", phone: null } },
  ];

  it("shows owner and admin the contact details, without placeholder addresses", async () => {
    const { service } = setup({ entries: rows() });
    const out = await service.list("t1", {}, { role: "owner" });
    expect(out[0].client).toMatchObject({ email: "ana@example.test", phone: "600111222" });
    expect(out[1].client.email).toBeNull();
    expect(out[0].contactHidden).toBe(false);
  });

  it("hides clients' email and phone from staff", async () => {
    const { service } = setup({ entries: rows() });
    const out = await service.list("t1", {}, { role: "staff" });
    expect(out[0].client).toEqual({ firstName: "Ana", lastName: "L", email: null, phone: null });
    expect(out[0].contactHidden).toBe(true);
  });
});

describe("WaitListService.onAppointmentCancelled", () => {
  const cancelled = { tenantId: "t1", serviceId: "s1", professionalId: "p1", date: D("2026-11-08"), time: "10:30" };
  const row = (i: number, extra: Record<string, any> = {}, client: Record<string, any> = {}) => ({
    id: `w${i}`,
    tenantId: "t1",
    clientId: `c${i}`,
    serviceId: "s1",
    professionalId: null,
    status: "waiting",
    earliestDate: null,
    latestDate: null,
    notifiedAt: null,
    createdAt: i,
    ...extra,
    client: { id: `c${i}`, firstName: "X", email: `x${i}@example.test`, phone: null, communicationPreferences: {}, status: "active", ...client },
  });
  const many = () => Array.from({ length: 5 }, (_, i) => row(i));

  it("with automatic notices on, tells the first three waiting clients about that slot", async () => {
    const { service, email } = setup({ emailConfigured: true, autoNotify: true, entries: many() });
    const out = await service.onAppointmentCancelled(cancelled);
    expect(out).toHaveLength(3);
    expect(email.sendEmail).toHaveBeenCalledTimes(3);
    expect(out[0].bookingUrl).toContain("professionalId=p1");
  });

  it("with them off, tells the salon's active managers instead of the clients", async () => {
    const { service, email, prisma, managerNotes } = setup({ emailConfigured: true, autoNotify: false, entries: many() });
    expect(await service.onAppointmentCancelled(cancelled)).toEqual([]);
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(managerNotes()[0]).toMatchObject({ userId: "u-owner", message: expect.stringMatching(/5 clientes/) });
    expect(prisma.user.findMany.mock.calls[0][0].where).toMatchObject({ isActive: true });
  });

  it("a client told about an earlier slot is offered the next one, but not twice in a few hours", async () => {
    const entries = [
      row(0, { status: "notified", notifiedAt: new Date(MORNING.getTime() - 2 * 24 * 3600_000) }),
      row(1, { status: "notified", notifiedAt: new Date(MORNING.getTime() - 3600_000) }),
    ];
    const { service, email } = setup({ emailConfigured: true, autoNotify: true, entries });
    const out = await service.onAppointmentCancelled(cancelled);
    expect(out).toHaveLength(1);
    expect(email.sendEmail.mock.calls.map((c: any[]) => c[0].to)).toEqual(["x0@example.test"]);
  });

  it("skips clients no channel can reach and tells the next ones", async () => {
    const entries = [
      row(0, {}, { email: null }),
      row(1, {}, { email: null }),
      row(2, {}, { email: null }),
      row(3),
      row(4),
    ];
    const { service, email } = setup({ emailConfigured: true, autoNotify: true, entries });
    const out = await service.onAppointmentCancelled(cancelled);
    expect(out.filter((r) => r.notified)).toHaveLength(2);
    expect(email.sendEmail.mock.calls.map((c: any[]) => c[0].to)).toEqual(["x3@example.test", "x4@example.test"]);
  });

  it("an entry starting the day after the slot is not offered it", async () => {
    const entries = [row(0, { earliestDate: D("2026-11-09") }), row(1, { latestDate: D("2026-11-08") })];
    const { service, email } = setup({ emailConfigured: true, autoNotify: true, entries });
    await service.onAppointmentCancelled(cancelled);
    expect(email.sendEmail.mock.calls.map((c: any[]) => c[0].to)).toEqual(["x1@example.test"]);
  });

  it("does not tell blocked or removed clients, nor the same client twice", async () => {
    const entries = [
      row(0, {}, { status: "blocked" }),
      row(1, {}, { status: "inactive" }),
      row(2),
      { ...row(3), clientId: "c2", client: { ...row(2).client } },
    ];
    const { service, email } = setup({ emailConfigured: true, autoNotify: true, entries });
    await service.onAppointmentCancelled(cancelled);
    expect(email.sendEmail.mock.calls.map((c: any[]) => c[0].to)).toEqual(["x2@example.test"]);
  });

  it("when nobody could be reached, tells the managers", async () => {
    const entries = [row(0, {}, { email: null }), row(1, {}, { email: null })];
    const { service, managerNotes } = setup({ emailConfigured: true, autoNotify: true, entries });
    const out = await service.onAppointmentCancelled(cancelled);
    expect(out.every((r) => !r.notified)).toBe(true);
    expect(managerNotes()).toHaveLength(1);
    expect(managerNotes()[0]).toMatchObject({
      title: "Hueco libre: nadie avisado",
      data: expect.objectContaining({ reason: "unreachable" }),
    });
  });

  it("with no channel configured at all, tries nobody and tells the managers", async () => {
    const { service, email, prisma, managerNotes } = setup({ autoNotify: true, entries: many() });
    expect(await service.onAppointmentCancelled(cancelled)).toEqual([]);
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(prisma.waitList.updateMany).not.toHaveBeenCalled();
    expect(managerNotes()[0].data.reason).toBe("unreachable");
  });

  it("sends nothing at night: the managers get a note to decide in the morning", async () => {
    // 22:30 in Madrid.
    const { service, email, managerNotes } = setup({
      emailConfigured: true,
      autoNotify: true,
      entries: many(),
      now: new Date("2026-11-02T21:30:00.000Z"),
    });
    expect(await service.onAppointmentCancelled(cancelled)).toEqual([]);
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(managerNotes()[0]).toMatchObject({
      message: expect.stringMatching(/de noche/),
      data: expect.objectContaining({ reason: "night" }),
    });
  });
});

describe("WaitListService.onAppointmentBooked", () => {
  it("closes the client's open entries for that service (any professional or the one booked)", async () => {
    const entries = [
      { id: "w1", tenantId: "t1", clientId: "c1", serviceId: "s1", professionalId: null, status: "notified" },
      { id: "w2", tenantId: "t1", clientId: "c1", serviceId: "s1", professionalId: "p2", status: "waiting" },
      { id: "w3", tenantId: "t1", clientId: "c1", serviceId: "s2", professionalId: null, status: "waiting" },
      { id: "w4", tenantId: "t1", clientId: "c9", serviceId: "s1", professionalId: null, status: "waiting" },
    ];
    const { service } = setup({ entries });
    const n = await service.onAppointmentBooked({ tenantId: "t1", clientId: "c1", serviceId: "s1", professionalId: "p1" });
    expect(n).toBe(1);
    expect(entries.map((e) => e.status)).toEqual(["fulfilled", "waiting", "waiting", "waiting"]);
  });
});

describe("wait-list helpers", () => {
  it("parseDay refuses impossible dates", () => {
    expect(parseDay("2026-11-05", "x")).toEqual(D("2026-11-05"));
    expect(() => parseDay("2026-13-01", "x")).toThrow(BadRequestException);
    expect(() => parseDay("2026-02-29", "x")).toThrow(BadRequestException);
  });

  it("the salon clock and the quiet hours", () => {
    expect(salonClock(new Date("2026-11-02T23:30:00.000Z"), "Europe/Madrid")).toEqual({ day: "2026-11-03", hour: 0 });
    expect(isQuietHour(8)).toBe(true);
    expect(isQuietHour(9)).toBe(false);
    expect(isQuietHour(20)).toBe(false);
    expect(isQuietHour(21)).toBe(true);
  });
});

describe("stale entries expire", () => {
  const DAY = 24 * 3600_000;
  const daysAgo = (n: number) => new Date(MORNING.getTime() - n * DAY);

  it("staleReason: a past 'hasta' (salon's day), or open-ended and untouched for too long", () => {
    expect(staleReason({ latestDate: D("2026-11-01") }, "2026-11-02", MORNING)).toBe("window_passed");
    expect(staleReason({ latestDate: D("2026-11-02") }, "2026-11-02", MORNING)).toBeNull();
    // A window still open is good however old the entry is.
    expect(staleReason({ latestDate: D("2026-12-01"), updatedAt: daysAgo(400) }, "2026-11-02", MORNING)).toBeNull();
    expect(staleReason({ updatedAt: daysAgo(WAIT_LIST_MAX_AGE_DAYS + 1) }, "2026-11-02", MORNING)).toBe("too_old");
    expect(staleReason({ updatedAt: daysAgo(WAIT_LIST_MAX_AGE_DAYS - 1) }, "2026-11-02", MORNING)).toBeNull();
    // Counted from a later "desde": a request for months ahead is not cut short.
    expect(staleReason({ updatedAt: daysAgo(200), earliestDate: daysAgo(10) }, "2026-11-02", MORNING)).toBeNull();
    expect(staleReason({}, "2026-11-02", MORNING)).toBeNull();
  });

  it("expireStale closes them with the reason and leaves the rest open", async () => {
    const entries = [
      { id: "w1", tenantId: "t1", status: "waiting", latestDate: D("2026-10-30"), updatedAt: daysAgo(5), createdAt: 1 },
      { id: "w2", tenantId: "t1", status: "notified", latestDate: null, earliestDate: null, updatedAt: daysAgo(120), createdAt: 2 },
      { id: "w3", tenantId: "t1", status: "waiting", latestDate: D("2026-11-20"), updatedAt: daysAgo(5), createdAt: 3 },
      { id: "w4", tenantId: "t1", status: "waiting", latestDate: null, earliestDate: null, updatedAt: daysAgo(10), createdAt: 4 },
      { id: "w5", tenantId: "t1", status: "fulfilled", latestDate: D("2026-10-01"), updatedAt: daysAgo(40), createdAt: 5 },
    ];
    const { service } = setup({ entries });
    expect(await service.expireStale()).toBe(2);
    expect(entries.map((e: any) => [e.status, e.closedReason ?? null])).toEqual([
      ["expired", "window_passed"],
      ["expired", "too_old"],
      ["waiting", null],
      ["waiting", null],
      ["fulfilled", null],
    ]);
  });

  it("uses each salon's own calendar day", async () => {
    // 23:30 UTC on 2 Nov is already 3 Nov in Madrid, still 2 Nov in the Canaries.
    const late = new Date("2026-11-02T23:30:00.000Z");
    const entries = [
      { id: "w1", tenantId: "t1", status: "waiting", latestDate: D("2026-11-02"), updatedAt: late, createdAt: 1,
        tenant: { timezone: "Europe/Madrid" } },
      { id: "w2", tenantId: "t2", status: "waiting", latestDate: D("2026-11-02"), updatedAt: late, createdAt: 2,
        tenant: { timezone: "Atlantic/Canary" } },
    ];
    const { service } = setup({ entries, now: late });
    expect(await service.expireStale()).toBe(1);
    expect(entries.map((e) => e.status)).toEqual(["expired", "waiting"]);
  });

  it("an expired entry is not offered a freed slot, and is closed then", async () => {
    const client = (id: string, email: string) => ({
      id, firstName: "A", email, phone: null, communicationPreferences: {}, status: "active",
    });
    const entries = [
      { id: "w1", tenantId: "t1", clientId: "c1", serviceId: "s1", professionalId: null, status: "waiting",
        earliestDate: null, latestDate: null, notifiedAt: null, createdAt: 1, updatedAt: daysAgo(200),
        client: client("c1", "old@example.test") },
      { id: "w2", tenantId: "t1", clientId: "c2", serviceId: "s1", professionalId: null, status: "waiting",
        earliestDate: null, latestDate: null, notifiedAt: null, createdAt: 2, updatedAt: daysAgo(3),
        client: client("c2", "new@example.test") },
    ];
    const { service, email } = setup({ emailConfigured: true, autoNotify: true, entries });
    await service.onAppointmentCancelled({ tenantId: "t1", serviceId: "s1", professionalId: null, date: D("2026-11-08") });
    expect(email.sendEmail.mock.calls.map((c: any[]) => c[0].to)).toEqual(["new@example.test"]);
    expect(entries[0].status).toBe("expired");
  });

  it("Avisar on a stale entry closes it and says why, without sending anything", async () => {
    const { service, email } = setup({
      emailConfigured: true,
      entries: [{ id: "w1", tenantId: "t1", status: "waiting", latestDate: D("2026-10-20"), client: {} }],
    });
    await expect(service.notify("t1", "w1")).rejects.toThrow(/caducado/);
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it("an expired entry is reopened only with a 'hasta' that has not passed; 'expired' is not set by hand", async () => {
    const entries = [
      { id: "w1", tenantId: "t1", clientId: "c1", serviceId: "s1", professionalId: null, status: "expired",
        latestDate: D("2026-10-20") },
    ];
    const { service, prisma } = setup({ entries });
    await expect(service.update("t1", "w1", { status: "waiting" })).rejects.toThrow(/ya ha pasado/);
    await service.update("t1", "w1", { status: "waiting", latestDate: "2026-11-30" });
    expect(prisma.waitList.update.mock.calls[0][0].data).toMatchObject({
      status: "waiting",
      closedReason: null,
      closedAt: null,
    });
    await expect(service.update("t1", "w1", { status: "expired" })).rejects.toBeInstanceOf(BadRequestException);
  });
});

describe("the 'Ya no me interesa' link", () => {
  const SECRET = "test-signing-secret-of-enough-length-000";
  const ID = "11111111-2222-4333-8444-555555555555";
  const entry = (status = "waiting") => ({
    id: ID,
    tenantId: "t1",
    clientId: "c1",
    serviceId: "s1",
    professionalId: null,
    status,
    earliestDate: null,
    latestDate: null,
    notifiedAt: null,
    createdAt: 1,
    client: {
      id: "c1", firstName: "Ana", email: "ana@example.test", phone: "600111222", communicationPreferences: {}, status: "active",
    },
  });
  let prevSecret: string | undefined;
  beforeEach(() => {
    prevSecret = process.env.JWT_SECRET;
    process.env.JWT_SECRET = SECRET;
  });
  afterEach(() => {
    if (prevSecret === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = prevSecret;
  });

  it("the token names the entry, is signed, and cannot be forged or reused with another secret", () => {
    const token = waitListLeaveToken(ID, SECRET);
    expect(parseWaitListLeaveToken(token, SECRET)).toBe(ID);
    expect(token).not.toContain("ana");
    const [payload, signature] = token.split(".");
    expect(signature).toHaveLength(32);
    expect(parseWaitListLeaveToken(token, "another-secret")).toBeNull();
    expect(parseWaitListLeaveToken(`${payload}.${"A".repeat(32)}`, SECRET)).toBeNull();
    const other = Buffer.from("w.99999999-2222-4333-8444-555555555555").toString("base64url");
    expect(parseWaitListLeaveToken(`${other}.${signature}`, SECRET)).toBeNull();
    expect(parseWaitListLeaveToken("", SECRET)).toBeNull();
    expect(parseWaitListLeaveToken(`${token}.x`, SECRET)).toBeNull();
    expect(parseWaitListLeaveToken(token, "")).toBeNull();
  });

  it("the email and the SMS carry the link; no client-area notice is recorded", async () => {
    const { service, email, sms, notifications } = setup({
      emailConfigured: true,
      smsConfigured: true,
      entries: [entry()],
    });
    const out = await service.notify("t1", ID, { date: "2026-11-08" });
    const token = encodeURIComponent(waitListLeaveToken(ID, SECRET));
    expect(email.sendEmail.mock.calls[0][0].html).toContain(`/public/lista-espera/${token}`);
    expect(email.sendEmail.mock.calls[0][0].html).toContain("Sal de la lista de espera");
    expect(sms.sendSms.mock.calls[0][0].body).toContain("Si ya no te interesa: ");
    expect(sms.sendSms.mock.calls[0][0].body).toContain(`/public/lista-espera/${token}`);
    expect(out.channels.some((c) => c.channel === "inApp")).toBe(false);
    expect(notifications.create.mock.calls.filter((c: any[]) => c[0].clientId)).toHaveLength(0);
  });

  it("describes the entry, then takes the client off the list; again is harmless", async () => {
    const entries: any[] = [entry("notified")];
    const { service } = setup({ entries });
    const token = waitListLeaveToken(ID, SECRET);
    expect(await service.describeLeaveLink(token)).toEqual({ salonName: "Salón Lucía", serviceName: "Corte", waiting: true });
    expect(await service.leaveByToken(token)).toMatchObject({ waiting: false });
    expect(entries[0]).toMatchObject({ status: "cancelled", closedReason: "client_left" });
    await expect(service.leaveByToken(token)).resolves.toMatchObject({ waiting: false });
    expect(entries[0].status).toBe("cancelled");
  });

  it("an entry closed meanwhile keeps its status", async () => {
    const entries = [entry("fulfilled")];
    const { service } = setup({ entries });
    await service.leaveByToken(waitListLeaveToken(ID, SECRET));
    expect(entries[0].status).toBe("fulfilled");
  });

  it("a bad or unknown token is a 404 that names nobody", async () => {
    const { service } = setup({ entries: [] });
    await expect(service.describeLeaveLink("nope")).rejects.toThrow(/Enlace no válido/);
    await expect(service.leaveByToken(waitListLeaveToken(ID, SECRET))).rejects.toThrow(/Enlace no válido/);
  });
});
