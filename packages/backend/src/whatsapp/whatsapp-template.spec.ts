import { WhatsAppTemplateService } from "./whatsapp-template.service";
import {
  APPOINTMENT_REMINDER,
  REVIEW_REQUEST,
  WAITLIST_SLOT_AVAILABLE,
  spanishDate,
  templateCreationPayload,
} from "./whatsapp-templates";
import { NotificationsScheduler } from "../notifications/notifications.scheduler";

/**
 * WhatsApp reminders went out as free text a day before the appointment,
 * outside WhatsApp's 24-hour window, so they were refused. They now use an
 * approved template from the salon's own number.
 */
function setup(over: { templates?: any[]; send?: any; create?: any; connection?: any } = {}) {
  const prisma: any = {
    whatsAppConnection: {
      findUnique: jest.fn(async () =>
        over.connection === undefined
          ? { wabaId: "waba1", phoneNumberId: "pn1", accessTokenEnc: "enc", isActive: true }
          : over.connection,
      ),
    },
  };
  const meta: any = {
    decryptToken: jest.fn(() => "token"),
    listTemplates: jest.fn(async () => ({
      data: over.templates ?? [{ name: APPOINTMENT_REMINDER.name, language: "es", status: "APPROVED" }],
    })),
    sendTemplate: jest.fn(async () => over.send ?? { messages: [{ id: "wamid.out" }] }),
    createTemplate: jest.fn(async () => over.create ?? { id: "t1", status: "PENDING" }),
  };
  return { service: new WhatsAppTemplateService(prisma, meta), meta };
}

const reminder = {
  phone: "600 111 222",
  clientName: "Ana",
  salonName: "Salón Lucía",
  serviceName: "Corte",
  date: new Date("2026-10-08T00:00:00.000Z"),
  time: "10:30",
};

describe("WhatsAppTemplateService", () => {
  it("sends the approved reminder template from the salon's number, with the client's number in international form", async () => {
    const { service, meta } = setup();
    const out = await service.sendAppointmentReminder("t1", reminder);
    expect(out).toEqual({ sent: true, messageId: "wamid.out" });
    const [token, phoneNumberId, to, name, lang, components] = meta.sendTemplate.mock.calls[0];
    expect([token, phoneNumberId, to, name, lang]).toEqual(["token", "pn1", "34600111222", APPOINTMENT_REMINDER.name, "es"]);
    expect(components[0].parameters.map((p: any) => p.text)).toEqual([
      "Ana",
      "Salón Lucía",
      "Corte",
      "jueves, 8 de octubre",
      "10:30",
    ]);
  });

  it("does not send while Meta has not approved the template, and says why", async () => {
    const { service, meta } = setup({ templates: [{ name: APPOINTMENT_REMINDER.name, language: "es", status: "PENDING" }] });
    expect(await service.sendAppointmentReminder("t1", reminder)).toEqual({ sent: false, reason: "template_pending" });
    expect(meta.sendTemplate).not.toHaveBeenCalled();
  });

  it("reports a salon without WhatsApp connected", async () => {
    const { service } = setup({ connection: null });
    expect(await service.sendAppointmentReminder("t1", reminder)).toEqual({ sent: false, reason: "not_connected" });
  });

  it("asks Meta for the review status once per half hour", async () => {
    const { service, meta } = setup();
    await service.sendAppointmentReminder("t1", reminder);
    await service.sendAppointmentReminder("t1", reminder);
    expect(meta.listTemplates).toHaveBeenCalledTimes(1);
  });

  it("submits the standard templates and treats an existing one as fine", async () => {
    const created = setup();
    expect(await created.service.submitStandardTemplates("t1")).toEqual({
      [APPOINTMENT_REMINDER.name]: "PENDING",
      [WAITLIST_SLOT_AVAILABLE.name]: "PENDING",
      [REVIEW_REQUEST.name]: "PENDING",
    });
    expect(created.meta.createTemplate.mock.calls[0][2]).toEqual(templateCreationPayload(APPOINTMENT_REMINDER));
    expect(created.meta.createTemplate.mock.calls[1][2]).toEqual(templateCreationPayload(WAITLIST_SLOT_AVAILABLE));
    expect(created.meta.createTemplate.mock.calls[2][2]).toEqual(templateCreationPayload(REVIEW_REQUEST));

    const exists = setup({ create: { error: { code: 100, message: "Message template already exists" } } });
    expect(await exists.service.submitStandardTemplates("t1")).toEqual({
      [APPOINTMENT_REMINDER.name]: "EXISTS",
      [WAITLIST_SLOT_AVAILABLE.name]: "EXISTS",
      [REVIEW_REQUEST.name]: "EXISTS",
    });
  });
});

describe("reminder template", () => {
  it.each([APPOINTMENT_REMINDER, WAITLIST_SLOT_AVAILABLE, REVIEW_REQUEST])("$name has one sample value per variable, as Meta's review requires", (t) => {
    const vars = t.body.match(/\{\{\d+\}\}/g) ?? [];
    expect(vars).toHaveLength(t.example.length);
    expect(t.category).toBe("UTILITY");
    // Meta refuses a body that starts or ends with a variable.
    expect(t.body.trim()).not.toMatch(/^\{\{|\}\}$/);
  });

  it("the wait-list notice too, and it neither starts nor ends with a variable", () => {
    const vars = WAITLIST_SLOT_AVAILABLE.body.match(/\{\{\d+\}\}/g) ?? [];
    expect(vars).toHaveLength(WAITLIST_SLOT_AVAILABLE.example.length);
    expect(WAITLIST_SLOT_AVAILABLE.body.trim()).not.toMatch(/^\{\{|\}\}$/);
  });

  it("writes dates the Spanish way", () => {
    expect(spanishDate(new Date("2026-10-08T00:00:00.000Z"))).toBe("jueves, 8 de octubre");
  });
});

describe("review request template", () => {
  it("goes out with the link as the last variable", async () => {
    const { service, meta } = setup({
      templates: [{ name: REVIEW_REQUEST.name, language: "es", status: "APPROVED" }],
    });
    const out = await service.sendReviewRequest("t1", {
      phone: "600 111 222",
      clientName: "Ana",
      salonName: "Salón Lucía",
      serviceName: "Corte",
      link: "https://app.example.test/public/r/tok",
    });
    expect(out.sent).toBe(true);
    const [, , to, name, , components] = meta.sendTemplate.mock.calls[0];
    expect([to, name]).toEqual(["34600111222", REVIEW_REQUEST.name]);
    expect(components[0].parameters.map((p: any) => p.text)).toEqual([
      "Ana",
      "Salón Lucía",
      "Corte",
      "https://app.example.test/public/r/tok",
    ]);
  });

  it("is not sent until Meta approves it, even if the reminder is approved", async () => {
    const { service, meta } = setup();
    const out = await service.sendReviewRequest("t1", {
      phone: "600111222",
      clientName: "Ana",
      salonName: "S",
      serviceName: "Corte",
      link: "https://x.test/r",
    });
    expect(out).toEqual({ sent: false, reason: "template_missing" });
    expect(meta.sendTemplate).not.toHaveBeenCalled();
  });
});

describe("NotificationsScheduler WhatsApp reminder", () => {
  const appointment = {
    id: "a1",
    tenantId: "t1",
    client: { firstName: "Ana", phone: "600111222" },
    tenant: { name: "Salón", country: "ES" },
    service: { name: "Corte" },
    professional: { firstName: "Lu", lastName: "Gil" },
    scheduledDate: new Date("2026-10-08T00:00:00.000Z"),
    scheduledTime: "10:30",
  };
  function scheduler(result: any) {
    const s = Object.create(NotificationsScheduler.prototype) as any;
    s.logger = { log: jest.fn(), error: jest.fn() };
    s.whatsappTemplates = { sendAppointmentReminder: jest.fn(async () => result) };
    s.whatsappService = { sendAppointmentReminder: jest.fn(async () => ({})) };
    return s;
  }

  it("uses the salon's template and skips Twilio when it went out", async () => {
    const s = scheduler({ sent: true });
    await s.sendWhatsAppReminder(appointment, 24);
    expect(s.whatsappService.sendAppointmentReminder).not.toHaveBeenCalled();
  });

  it("falls back to the Twilio sender otherwise", async () => {
    const s = scheduler({ sent: false, reason: "not_connected" });
    await s.sendWhatsAppReminder(appointment, 1);
    expect(s.whatsappService.sendAppointmentReminder).toHaveBeenCalledWith(expect.objectContaining({ clientPhone: "600111222" }), 1);
  });
});
