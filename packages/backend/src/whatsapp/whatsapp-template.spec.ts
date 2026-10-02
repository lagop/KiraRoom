import { WhatsAppTemplateService } from "./whatsapp-template.service";
import {
  APPOINTMENT_CANCELLED,
  APPOINTMENT_CONFIRMED,
  APPOINTMENT_REMINDER,
  APPOINTMENT_RESCHEDULED,
  STANDARD_TEMPLATES,
  spanishDate,
  templateCreationPayload,
  templateParam,
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

  it("submits every standard template and treats an existing one as fine", async () => {
    const created = setup();
    const all = Object.fromEntries(STANDARD_TEMPLATES.map((t) => [t.name, "PENDING"]));
    expect(await created.service.submitStandardTemplates("t1")).toEqual(all);
    expect(created.meta.createTemplate.mock.calls.map((c: any[]) => c[2])).toEqual(
      STANDARD_TEMPLATES.map(templateCreationPayload),
    );

    const exists = setup({ create: { error: { code: 100, message: "Message template already exists" } } });
    expect(await exists.service.submitStandardTemplates("t1")).toEqual(
      Object.fromEntries(STANDARD_TEMPLATES.map((t) => [t.name, "EXISTS"])),
    );
  });
});

/**
 * Confirmations, cancellations and changes of an appointment went out as
 * free text, which WhatsApp refuses outside the 24-hour window -- the usual
 * case for a booking made by phone or at the desk. They now have their own
 * approved templates, used the same way as the reminder.
 */
describe("WhatsAppTemplateService appointment notices", () => {
  const approved = STANDARD_TEMPLATES.map((t) => ({ name: t.name, language: "es", status: "APPROVED" }));
  const notice = {
    phone: "+34 600 111 222",
    clientName: "Ana",
    salonName: "Salón Lucía",
    serviceName: "Corte",
    date: new Date("2026-10-09T00:00:00.000Z"),
    time: "17:00",
  };

  it.each([
    ["confirmed", APPOINTMENT_CONFIRMED],
    ["cancelled", APPOINTMENT_CANCELLED],
    ["rescheduled", APPOINTMENT_RESCHEDULED],
  ] as const)("sends the %s template from the salon's number", async (kind, template) => {
    const { service, meta } = setup({ templates: approved });
    expect(await service.sendAppointmentNotice("t1", kind, notice)).toEqual({ sent: true, messageId: "wamid.out" });
    const [, , to, name, lang, components] = meta.sendTemplate.mock.calls[0];
    expect([to, name, lang]).toEqual(["34600111222", template.name, "es"]);
    expect(components[0].parameters.map((p: any) => p.text)).toEqual([
      "Ana",
      "Salón Lucía",
      "Corte",
      "viernes, 9 de octubre",
      "17:00",
    ]);
  });

  it("falls back while a template is in review, without resubmitting it", async () => {
    const { service, meta } = setup({
      templates: [{ name: APPOINTMENT_CANCELLED.name, language: "es", status: "PENDING" }],
    });
    expect(await service.sendAppointmentNotice("t1", "cancelled", notice)).toEqual({
      sent: false,
      reason: "template_pending",
    });
    expect(meta.sendTemplate).not.toHaveBeenCalled();
    expect(meta.createTemplate).not.toHaveBeenCalled();
  });

  it("submits the standard set when a salon connected before these templates existed, at most once in 6 hours", async () => {
    const { service, meta } = setup({ templates: [{ name: APPOINTMENT_REMINDER.name, language: "es", status: "APPROVED" }] });
    expect(await service.sendAppointmentNotice("t1", "confirmed", notice)).toEqual({
      sent: false,
      reason: "template_missing",
    });
    await new Promise((r) => setImmediate(r));
    expect(meta.createTemplate).toHaveBeenCalledTimes(STANDARD_TEMPLATES.length);
    meta.listTemplates.mockClear();
    await service.sendAppointmentNotice("t1", "rescheduled", notice);
    await new Promise((r) => setImmediate(r));
    expect(meta.createTemplate).toHaveBeenCalledTimes(STANDARD_TEMPLATES.length);
  });

  it("never sends an empty or multi-line variable, which Meta refuses", async () => {
    const { service, meta } = setup({ templates: approved });
    await service.sendAppointmentNotice("t1", "confirmed", { ...notice, clientName: "", serviceName: "Corte\ny color" });
    const texts = meta.sendTemplate.mock.calls[0][5][0].parameters.map((p: any) => p.text);
    expect(texts[0]).toBe("de nuevo");
    expect(texts[2]).toBe("Corte y color");
    expect(templateParam("   ")).toBe("-");
  });
});

describe("standard templates", () => {
  it.each(STANDARD_TEMPLATES.map((t) => [t.name, t] as const))(
    "%s has one sample per variable, is UTILITY, and neither starts nor ends with a variable",
    (_name, t) => {
      const vars = t.body.match(/\{\{\d+\}\}/g) ?? [];
      expect(vars).toHaveLength(t.example.length);
      expect(t.category).toBe("UTILITY");
      expect(t.body.trim()).not.toMatch(/^\{\{|\}\}$/);
      expect(t.name).toMatch(/^[a-z0-9_]+$/);
    },
  );

  it("are distinct", () => {
    expect(new Set(STANDARD_TEMPLATES.map((t) => t.name)).size).toBe(STANDARD_TEMPLATES.length);
  });

  it("writes dates the Spanish way", () => {
    expect(spanishDate(new Date("2026-10-08T00:00:00.000Z"))).toBe("jueves, 8 de octubre");
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
