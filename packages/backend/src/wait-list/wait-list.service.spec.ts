import { BadRequestException } from "@nestjs/common";
import { WaitListService } from "./wait-list.service";

/**
 * "Avisar" flipped the entry to "notified" and sent nothing; a cancelled
 * appointment did the same to every matching client. A notice now goes out
 * through the real channels, honours the client's opt-outs, and the entry is
 * only marked notified when something was actually delivered. When nothing
 * can deliver (no provider configured), the answer says so.
 */

function setup(
  over: {
    client?: Record<string, any>;
    emailConfigured?: boolean;
    smsConfigured?: boolean;
    whatsapp?: { sent: boolean; reason?: string };
    autoNotify?: boolean;
    entries?: any[];
    prefs?: (channel: string) => boolean;
  } = {},
) {
  const entry = {
    id: "w1",
    tenantId: "t1",
    clientId: "c1",
    serviceId: "s1",
    professionalId: null,
    status: "waiting",
    client: {
      id: "c1",
      firstName: "Ana",
      email: "ana@example.test",
      phone: "600111222",
      communicationPreferences: {},
      ...over.client,
    },
  };
  const entries = over.entries ?? [entry];
  const prisma: any = {
    waitList: {
      findFirst: jest.fn(async ({ where }: any) => entries.find((e) => e.id === where.id && e.tenantId === where.tenantId) ?? null),
      findMany: jest.fn(async () => entries),
      update: jest.fn(async ({ data }: any) => data),
    },
    tenant: {
      findUnique: jest.fn(async () => ({
        name: "Salón Lucía",
        slug: "salon-lucia",
        country: "ES",
        waitListAutoNotify: over.autoNotify ?? false,
      })),
      update: jest.fn(),
    },
    service: { findFirst: jest.fn(async () => ({ name: "Corte" })) },
    professional: { findFirst: jest.fn(async () => ({ firstName: "Lu" })) },
    user: { findMany: jest.fn(async () => [{ id: "u-owner" }]) },
  };
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
  return { service, prisma, notifications, email, sms, whatsapp };
}

describe("WaitListService.notify (Avisar)", () => {
  it("with no provider configured, says so and does not pretend the client was told", async () => {
    const { service, prisma } = setup();
    const out = await service.notify("t1", "w1", { date: "2026-10-08", time: "10:30" }, "u1");

    expect(out.notified).toBe(false);
    expect(out.summary).toMatch(/no hay proveedor de email configurado/);
    expect(out.summary).toMatch(/no hay proveedor de SMS configurado/);
    const data = prisma.waitList.update.mock.calls[0][0].data;
    expect(data.status).toBeUndefined();
    expect(data.lastNotification.channels.length).toBeGreaterThan(0);
  });

  it("sends the email with a link to book the freed slot and records the notice", async () => {
    const { service, prisma, email } = setup({ emailConfigured: true });
    const out = await service.notify("t1", "w1", { date: "2026-10-08", time: "10:30" }, "u1");

    expect(out.notified).toBe(true);
    expect(out.bookingUrl).toContain("/sites/salon-lucia?serviceId=s1");
    expect(out.bookingUrl).toContain("date=2026-10-08");
    const html = email.sendEmail.mock.calls[0][0].html as string;
    expect(html).toContain("10:30");
    expect(html).toContain("/sites/salon-lucia");
    const data = prisma.waitList.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ status: "notified", notifyCount: { increment: 1 } });
    expect(data.lastNotification).toMatchObject({ by: "u1", auto: false });
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
});

describe("WaitListService.onAppointmentCancelled", () => {
  const cancelled = { tenantId: "t1", serviceId: "s1", professionalId: "p1", date: new Date("2026-10-08T00:00:00.000Z"), time: "10:30" };
  const many = Array.from({ length: 5 }, (_, i) => ({
    id: `w${i}`,
    tenantId: "t1",
    serviceId: "s1",
    status: "waiting",
    client: { id: `c${i}`, firstName: "X", email: `x${i}@example.test`, phone: null, communicationPreferences: {} },
  }));

  it("with automatic notices on, tells the first three waiting clients about that slot", async () => {
    const { service, email } = setup({ emailConfigured: true, autoNotify: true, entries: many });
    const out = await service.onAppointmentCancelled(cancelled);
    expect(out).toHaveLength(3);
    expect(email.sendEmail).toHaveBeenCalledTimes(3);
    expect(out[0].bookingUrl).toContain("professionalId=p1");
  });

  it("with them off, tells the salon's managers instead of the clients", async () => {
    const { service, email, notifications } = setup({ emailConfigured: true, autoNotify: false, entries: many });
    expect(await service.onAppointmentCancelled(cancelled)).toEqual([]);
    expect(email.sendEmail).not.toHaveBeenCalled();
    expect(notifications.create).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u-owner", message: expect.stringMatching(/5 clientes/) }),
    );
  });
});
