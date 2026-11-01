import { BadRequestException, NotFoundException } from "@nestjs/common";
import { ConsentService } from "./consent.service";
import { ConsentController } from "./consent.controller";
import {
  BOOKING_EMAIL_REFUSAL_TEXT,
  BOOKING_WHATSAPP_NOTICES_TEXT,
  MARKETING_FIELDS,
  MARKETING_PURPOSE,
  SYSTEM_CONSENT_PURPOSES,
  WHATSAPP_MARKETING_FIELDS,
  WHATSAPP_NOTICES_FIELDS,
  WHATSAPP_NOTICES_PURPOSE,
  clientsWhoRefusedMarketing,
} from "./marketing-consent";
import { APPOINTMENT_NOTICE_TYPES, noticeChannelsOf, withNoticeChannels } from "./client-notices";

/**
 * The owner's decisions of 2026-11-01: clients have no accounts, so what a
 * client chooses about promotions and appointment notices is ticked where
 * her details are taken (booking page, widget) or written down by the salon
 * on her file -- never "desde mi cuenta".
 */

function makePrisma(opts: { phone?: string | null; email?: string | null; connected?: boolean } = {}) {
  const forms: any[] = [];
  const consents: any[] = [];
  const prefs = new Map<string, any>();
  const matches = (c: any, where: any) =>
    (!where.tenantId || c.tenantId === where.tenantId) &&
    (!where.clientId || (typeof where.clientId === "string" ? c.clientId === where.clientId : where.clientId.in.includes(c.clientId))) &&
    (where.revokedAt !== null || c.revokedAt === null) &&
    (!where.form || forms.find((f) => f.id === c.formId)?.purpose === where.form.purpose);
  const client = {
    id: "c1",
    tenantId: "t1",
    firstName: "Ana",
    lastName: "Pérez",
    phone: opts.phone === undefined ? "600 111 222" : opts.phone,
    email: opts.email === undefined ? "ana@example.test" : opts.email,
  };
  const prisma: any = {
    client: {
      findFirst: jest.fn(async ({ where }: any) => {
        if (where.id !== "c1" || where.tenantId !== "t1") return null;
        // Staff reach: an appointment with the staff member's professional record.
        const userId = where.appointments?.some?.professional?.userId;
        if (userId && userId !== "staff-with-her") return null;
        return client;
      }),
    },
    consentForm: {
      findFirst: async ({ where }: any) =>
        forms.filter((f) => f.tenantId === where.tenantId && f.purpose === where.purpose && f.isActive).sort((a, b) => b.version - a.version)[0] ?? null,
      create: async ({ data }: any) => {
        const row = { id: `f${forms.length + 1}`, isActive: true, ...data };
        forms.push(row);
        return row;
      },
      updateMany: async ({ where, data }: any) => {
        const rows = forms.filter((f) => f.id === where.id && (where.isActive === undefined || f.isActive === where.isActive));
        rows.forEach((f) => Object.assign(f, data));
        return { count: rows.length };
      },
    },
    consent: {
      findFirst: async ({ where }: any) =>
        consents.filter((c) => matches(c, where)).sort((a, b) => b.signedAt - a.signedAt)[0] ?? null,
      findMany: async ({ where }: any) => consents.filter((c) => matches(c, where)),
      updateMany: async ({ where, data }: any) => {
        const rows = consents.filter((c) => matches(c, where));
        rows.forEach((c) => Object.assign(c, data));
        return { count: rows.length };
      },
      create: async ({ data }: any) => {
        const row = { id: `k${consents.length + 1}`, revokedAt: null, ...data };
        consents.push(row);
        return row;
      },
    },
    notificationPreference: {
      findUnique: async ({ where }: any) => (prefs.has(where.clientId) ? { preferences: prefs.get(where.clientId) } : null),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        prefs.set(where.clientId, prefs.has(where.clientId) ? update.preferences : create.preferences);
        return {};
      }),
    },
    whatsAppConnection: {
      findUnique: async () => (opts.connected === false ? null : { isActive: true, phoneNumberId: "pn-1" }),
    },
  };
  prisma.$transaction = async (fn: any) => fn(prisma);
  return { prisma, forms, consents, prefs };
}

const encryption: any = { hashIp: (ip: string) => `hash(${ip})` };

describe("what the client ticks when booking online", () => {
  it("\"No quiero recibir promociones\" records a refusal with the text she saw, where and with which booking", async () => {
    const { prisma, consents } = makePrisma();
    const service = new ConsentService(prisma, encryption);

    await service.recordBookingChoices({
      tenantId: "t1",
      clientId: "c1",
      appointmentId: "a1",
      source: "widget",
      ip: "1.2.3.4",
      typedPhone: "600111222",
      refusesMarketingEmail: true,
    });

    expect(consents).toHaveLength(1);
    expect(consents[0]).toMatchObject({
      clientId: "c1",
      appointmentId: "a1",
      responses: { accepts: false, source: "widget", shown: BOOKING_EMAIL_REFUSAL_TEXT },
      signatureIpHash: "hash(1.2.3.4)",
      revokedAt: null,
    });
    // Campaigns leave her out.
    expect([...(await clientsWhoRefusedMarketing(prisma, "t1"))]).toEqual(["c1"]);
    expect((await service.getMarketingConsent("t1", "c1")).source).toBe("widget");
  });

  it("unticked boxes record nothing (the existing-customer exception applies)", async () => {
    const { prisma, consents } = makePrisma();
    const service = new ConsentService(prisma, encryption);
    await service.recordBookingChoices({ tenantId: "t1", clientId: "c1", source: "booking", typedPhone: "600111222" });
    await service.recordBookingChoices({
      tenantId: "t1",
      clientId: "c1",
      source: "booking",
      refusesMarketingEmail: false,
      wantsWhatsAppNotices: false,
    });
    expect(consents).toHaveLength(0);
    expect(prisma.notificationPreference.upsert).not.toHaveBeenCalled();
  });

  it("\"Recibir los avisos de mi cita por WhatsApp\" turns WhatsApp on for every appointment notice and records the request", async () => {
    const { prisma, consents, forms, prefs } = makePrisma();
    const service = new ConsentService(prisma, encryption);

    await service.recordBookingChoices({
      tenantId: "t1",
      clientId: "c1",
      appointmentId: "a1",
      source: "booking",
      typedPhone: "+34 600 111 222",
      wantsWhatsAppNotices: true,
    });

    const stored = prefs.get("c1");
    for (const type of APPOINTMENT_NOTICE_TYPES) expect(stored[type].whatsapp).toBe(true);
    // Email and SMS untouched: still their defaults.
    expect(noticeChannelsOf(stored)).toEqual({ email: true, sms: true, whatsapp: true });
    expect(forms.find((f) => f.id === consents[0].formId).purpose).toBe(WHATSAPP_NOTICES_PURPOSE);
    expect(consents[0]).toMatchObject({
      appointmentId: "a1",
      responses: { accepts: true, source: "booking", shown: BOOKING_WHATSAPP_NOTICES_TEXT },
    });
    const state = await service.getClientNotices("t1", "c1");
    expect(state.whatsappRequest).toMatchObject({ status: "granted", source: "booking" });
  });

  it("is not honoured when the salon has no WhatsApp connected", async () => {
    const { prisma, consents, prefs } = makePrisma({ connected: false });
    await new ConsentService(prisma, encryption).recordBookingChoices({
      tenantId: "t1",
      clientId: "c1",
      source: "booking",
      typedPhone: "600111222",
      wantsWhatsAppNotices: true,
    });
    expect(consents).toHaveLength(0);
    expect(prefs.size).toBe(0);
  });

  it("is not honoured for a number other than the one on her file (an existing client found by email)", async () => {
    const { prisma, consents, prefs } = makePrisma({ phone: "611 999 888" });
    await new ConsentService(prisma, encryption).recordBookingChoices({
      tenantId: "t1",
      clientId: "c1",
      source: "booking",
      typedPhone: "600111222",
      wantsWhatsAppNotices: true,
    });
    expect(consents).toHaveLength(0);
    expect(prefs.size).toBe(0);
  });

  it("never fails the booking", async () => {
    const { prisma } = makePrisma();
    prisma.consent.create = async () => {
      throw new Error("db down");
    };
    await expect(
      new ConsentService(prisma, encryption).recordBookingChoices({
        tenantId: "t1",
        clientId: "c1",
        source: "booking",
        typedPhone: "600111222",
        refusesMarketingEmail: true,
        wantsWhatsAppNotices: true,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("the salon's controls on the client file", () => {
  const req = (role = "owner", id = "owner-1"): any => ({ user: { id, tenantId: "t1", role }, headers: {}, socket: {} });

  it("records \"no quiere promociones por email\", and never an acceptance", async () => {
    const { prisma, consents } = makePrisma();
    const controller = new ConsentController(new ConsentService(prisma, encryption));

    await expect(controller.setClientEmailMarketing(req(), "c1", { accepts: true })).rejects.toThrow(BadRequestException);
    expect(consents).toHaveLength(0);

    const state = await controller.setClientEmailMarketing(req(), "c1", { accepts: false });
    expect(state).toMatchObject({ status: "refused", source: "salon" });
    expect(consents[0].responses).toEqual({ accepts: false, source: "salon", recordedBy: "owner-1" });
  });

  it("staff reach only clients with an appointment with them, as on the client file", async () => {
    const { prisma } = makePrisma();
    const controller = new ConsentController(new ConsentService(prisma, encryption));
    await expect(controller.clientNotices(req("staff", "other-staff"), "c1")).rejects.toThrow(NotFoundException);
    await expect(controller.setClientEmailMarketing(req("staff", "other-staff"), "c1", { accepts: false })).rejects.toThrow(
      NotFoundException,
    );
    await expect(controller.clientNotices(req("staff", "staff-with-her"), "c1")).resolves.toMatchObject({
      channels: { email: true, sms: true, whatsapp: false },
    });
  });

  it("shows the default channels when nothing was chosen", async () => {
    const { prisma } = makePrisma({ connected: false });
    const state = await new ConsentService(prisma, encryption).getClientNotices("t1", "c1");
    expect(state).toMatchObject({
      channels: { email: true, sms: true, whatsapp: false },
      whatsappRequest: { status: "none" },
      available: { email: true, whatsapp: false },
      contact: { email: true, phone: true },
    });
  });

  it("turns WhatsApp notices on only after confirming the client asked, and says who wrote it down", async () => {
    const { prisma, consents, prefs } = makePrisma();
    const controller = new ConsentController(new ConsentService(prisma, encryption));

    await expect(controller.setClientNotices(req("staff", "staff-with-her"), "c1", { whatsapp: true })).rejects.toThrow(
      BadRequestException,
    );
    expect(consents).toHaveLength(0);

    const state = await controller.setClientNotices(req("staff", "staff-with-her"), "c1", { whatsapp: true, clientAsked: true });
    expect(state.channels.whatsapp).toBe(true);
    expect(state.whatsappRequest).toMatchObject({ status: "granted", source: "salon" });
    expect(consents[0].responses).toEqual({ accepts: true, source: "salon", recordedBy: "staff-with-her" });

    // Off: the request is withdrawn (kept, revoked) and the channel goes off.
    const off = await controller.setClientNotices(req("staff", "staff-with-her"), "c1", { whatsapp: false });
    expect(off.channels.whatsapp).toBe(false);
    expect(consents[0].revokeReason).toBe("withdrawn_by_salon");
    expect(consents[1].responses).toMatchObject({ accepts: false, source: "salon" });
    for (const type of APPOINTMENT_NOTICE_TYPES) expect(prefs.get("c1")[type].whatsapp).toBe(false);
  });

  it("refuses WhatsApp for a client without a phone, or a salon without WhatsApp", async () => {
    const noPhone = makePrisma({ phone: null });
    await expect(
      new ConsentService(noPhone.prisma, encryption).setClientNotices({
        tenantId: "t1",
        clientId: "c1",
        changes: { whatsapp: true },
        recordedBy: "owner-1",
        clientAsked: true,
      }),
    ).rejects.toThrow(/teléfono/);
    const notConnected = makePrisma({ connected: false });
    await expect(
      new ConsentService(notConnected.prisma, encryption).setClientNotices({
        tenantId: "t1",
        clientId: "c1",
        changes: { whatsapp: true },
        recordedBy: "owner-1",
        clientAsked: true,
      }),
    ).rejects.toThrow(/Conecta el WhatsApp/);
  });

  it("email and SMS switches change only those channels and record no consent", async () => {
    const { prisma, consents, prefs } = makePrisma();
    const service = new ConsentService(prisma, encryption);
    prefs.set("c1", { review_request: { email: false }, appointment_confirmed: { inApp: false } });

    const state = await service.setClientNotices({ tenantId: "t1", clientId: "c1", changes: { sms: false }, recordedBy: "owner-1" });

    expect(state.channels).toEqual({ email: true, sms: false, whatsapp: false });
    expect(consents).toHaveLength(0);
    // Other notice types and channels as they were.
    expect(prefs.get("c1").review_request).toEqual({ email: false });
    expect(prefs.get("c1").appointment_confirmed).toEqual({ inApp: false, sms: false });
  });
});

describe("the wording never sends a client to an account", () => {
  it("no system form mentions an account", () => {
    for (const fields of [MARKETING_FIELDS, WHATSAPP_MARKETING_FIELDS, WHATSAPP_NOTICES_FIELDS]) {
      expect(fields[0].label).not.toMatch(/cuenta/i);
    }
    expect(MARKETING_FIELDS[0].label).toMatch(/enlace que llega en cada email/);
    expect(WHATSAPP_MARKETING_FIELDS[0].label).toMatch(/BAJA/);
  });

  it("a salon's form saved with the old wording gets a new version; old records keep theirs", async () => {
    const { prisma, forms, consents } = makePrisma();
    const old = [{ ...MARKETING_FIELDS[0], label: "Quiero recibir ... Puedo retirar este consentimiento cuando quiera desde mi cuenta." }];
    forms.push({ id: "f-old", tenantId: "t1", purpose: MARKETING_PURPOSE, isActive: true, version: 1, fields: old });
    consents.push({
      id: "k-old",
      tenantId: "t1",
      clientId: "c1",
      formId: "f-old",
      formSnapshot: old,
      responses: { accepts: true },
      signedAt: new Date("2026-10-01"),
      revokedAt: null,
    });
    const service = new ConsentService(prisma, encryption);

    await service.recordMarketingChoice({ tenantId: "t1", clientId: "c1", accepts: false, recordedBy: "owner-1" });

    expect(forms[0].isActive).toBe(false);
    expect(forms[1]).toMatchObject({ isActive: true, version: 2, fields: MARKETING_FIELDS });
    expect(consents[0].formSnapshot).toBe(old);
    expect(consents[1]).toMatchObject({ formId: forms[1].id, formSnapshot: MARKETING_FIELDS });
  });

  it("records word for word the boxes the booking page and the widget show", () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require("fs");
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require("path");
    const source: string = fs.readFileSync(path.join(__dirname, "../../../frontend/lib/public-booking.ts"), "utf8");
    const text = (key: string) => new RegExp(`${key}: "([^"]+)"`).exec(source)?.[1];
    expect(`${text("emailRefusal")} ${text("emailNotice")}`).toBe(BOOKING_EMAIL_REFUSAL_TEXT);
    expect(text("whatsappNotices")).toBe(BOOKING_WHATSAPP_NOTICES_TEXT);
  });

  it("the WhatsApp notices form is a system form: never listed or required for a booking", () => {
    expect(SYSTEM_CONSENT_PURPOSES).toContain(WHATSAPP_NOTICES_PURPOSE);
  });
});

describe("appointment notice channels", () => {
  it("a channel is on only when every appointment notice has it", () => {
    expect(noticeChannelsOf(undefined)).toEqual({ email: true, sms: true, whatsapp: false });
    expect(noticeChannelsOf({ appointment_reminder_1h: { email: false } }).email).toBe(false);
    expect(noticeChannelsOf(withNoticeChannels({}, { whatsapp: true })).whatsapp).toBe(true);
  });
});
