/**
 * The appointment emails to the client (confirmation, reminders,
 * cancellation, change of date) and the appointment SMS.
 *
 * Before: in English (the confirmation half and half), with a server-wide
 * SALON_NAME setting replacing every salon's name, names inserted into the
 * HTML unescaped, and the SMS signed "KiraRoom:".
 */

import { EmailService, AppointmentEmailData, displayDate } from "./email.service";
import { SmsService, AppointmentSmsData } from "./sms.service";

function makeService(env: Record<string, string | undefined> = {}) {
  const values: Record<string, string | undefined> = {
    RESEND_API_KEY: "re_test_key",
    EMAIL_FROM: "Reservas <citas@example.test>",
    ...env,
  };
  const config = { get: (key: string) => values[key] } as any;
  const service = new EmailService(config, { translate: () => "translated" } as any, {} as any);
  const calls: any[] = [];
  (service as any).resend = {
    emails: {
      send: async (payload: any) => {
        calls.push(payload);
        return { data: { id: `resend-${calls.length}` }, error: null };
      },
    },
  };
  (service as any).resendKey = values.RESEND_API_KEY;
  return { service, calls };
}

const MARKUP = '<b onmouseover="x">Ana</b>';

function data(overrides: Partial<AppointmentEmailData> = {}): AppointmentEmailData {
  return {
    clientName: "Ana García",
    clientEmail: "ana@example.test",
    serviceName: "Corte & peinado",
    professionalName: "Lucía Pérez",
    date: "2026-11-02",
    time: "10:30",
    salonName: "Salón Lucía",
    salonAddress: "Calle Mayor 1, Madrid",
    ...overrides,
  };
}

const sends: Array<[string, (s: EmailService, d: AppointmentEmailData) => Promise<unknown>]> = [
  ["confirmation", (s, d) => s.sendAppointmentConfirmation(d)],
  ["24h reminder", (s, d) => s.sendAppointmentReminder(d, 24)],
  ["1h reminder", (s, d) => s.sendAppointmentReminder(d, 1)],
  ["cancellation", (s, d) => s.sendAppointmentCancellation(d, "La profesional está enferma")],
  ["change of date", (s, d) => s.sendAppointmentRescheduled(d, "2026-10-30", "17:00")],
];

describe("appointment emails to the client", () => {
  it.each(sends)("%s: in Spanish, with the salon's own name and a Spanish date", async (_label, send) => {
    const { service, calls } = makeService({ SALON_NAME: "Otro Nombre" });
    await send(service, data());
    const { subject, html, text } = calls[0];

    for (const part of [subject, html, text]) {
      expect(part).not.toMatch(/\b(Appointment|Reminder|Hi|Cancelled|Rescheduled|Service:|Date:|Time:|This email was sent)\b/);
      // SALON_NAME no longer replaces the salon's name.
      expect(part).not.toContain("Otro Nombre");
    }
    expect(subject).toContain("Salón Lucía");
    expect(html).toContain('<html lang="es">');
    expect(html).toContain("Hola <strong>Ana García</strong>");
    expect(text).toContain("Hola Ana García,");
    expect(html).toContain("Servicio:");
    expect(html).toContain("lunes, 2 de noviembre de 2026");
    expect(text).toContain("Fecha: lunes, 2 de noviembre de 2026");
    expect(text).toContain("Este email se ha enviado a ana@example.test");
  });

  it.each(sends)("%s: escapes every value in the HTML, not in the plain text", async (_label, send) => {
    const { service, calls } = makeService();
    await send(
      service,
      data({ clientName: MARKUP, salonName: `Salón ${MARKUP}`, serviceName: MARKUP, professionalName: MARKUP, salonAddress: MARKUP }),
    );
    const { html, text, subject } = calls[0];
    expect(html).not.toContain("<b ");
    expect(html).toContain("&lt;b onmouseover=&quot;x&quot;&gt;Ana&lt;/b&gt;");
    // Plain text and subject are not HTML: shown as typed.
    expect(text).toContain(MARKUP);
    expect(subject).toContain(`Salón ${MARKUP}`);
  });

  it("escapes the cancellation reason and the previous date", async () => {
    const { service, calls } = makeService();
    await service.sendAppointmentCancellation(data(), MARKUP);
    expect(calls[0].html).toContain("Motivo:");
    expect(calls[0].html).not.toContain("<b ");
    await service.sendAppointmentRescheduled(data(), MARKUP, "17:00");
    expect(calls[1].html).not.toContain("<b ");
    expect(calls[1].html).toContain("<strong>Antes:</strong>");
  });

  it("subjects say what happened, in Spanish", async () => {
    const { service, calls } = makeService();
    await service.sendAppointmentConfirmation(data());
    await service.sendAppointmentReminder(data(), 24);
    await service.sendAppointmentReminder(data(), 1);
    await service.sendAppointmentCancellation(data());
    await service.sendAppointmentRescheduled(data(), "2026-10-30", "17:00");
    expect(calls.map((c) => c.subject)).toEqual([
      "Tu cita en Salón Lucía está confirmada",
      "Recordatorio: mañana tienes cita en Salón Lucía (Corte & peinado)",
      "Recordatorio: tu cita en Salón Lucía es dentro de 1 hora",
      "Cita cancelada en Salón Lucía: Corte & peinado, lunes, 2 de noviembre de 2026",
      "Tu cita en Salón Lucía ha cambiado: lunes, 2 de noviembre de 2026 a las 10:30",
    ]);
  });

  it("keeps a date the caller already formatted as given", () => {
    expect(displayDate("domingo, 1 de noviembre de 2026")).toBe("domingo, 1 de noviembre de 2026");
    expect(displayDate("2026-11-02T00:00:00.000Z")).toBe("lunes, 2 de noviembre de 2026");
  });
});

describe("appointment SMS to the client", () => {
  function sms() {
    const service = new SmsService({ get: () => undefined } as any, {} as any);
    const sent: string[] = [];
    (service as any).sendSms = async ({ body }: { body: string }) => {
      sent.push(body);
      return { success: true };
    };
    return { service, sent };
  }
  const smsData: AppointmentSmsData = {
    clientName: "Ana",
    clientPhone: "600111222",
    serviceName: "Corte",
    professionalName: "Lucía",
    date: "2026-11-02",
    time: "10:30",
    salonName: "Salón Lucía",
  };

  it("are signed with the salon's name, not KiraRoom", async () => {
    const { service, sent } = sms();
    await service.sendAppointmentConfirmation(smsData);
    await service.sendAppointmentReminder(smsData, 24);
    await service.sendAppointmentReminder(smsData, 1);
    await service.sendAppointmentCancellation(smsData);
    await service.sendAppointmentRescheduled(smsData, "2026-10-30", "17:00");
    expect(sent).toHaveLength(5);
    for (const body of sent) {
      expect(body.startsWith("Salón Lucía: ")).toBe(true);
      expect(body).not.toContain("KiraRoom");
    }
    expect(sent[0]).toContain("el lunes, 2 de noviembre de 2026 a las 10:30");
  });

  it("fall back to a neutral signature when the salon has no name", async () => {
    const { service, sent } = sms();
    await service.sendAppointmentReminder({ ...smsData, salonName: "  " }, 24);
    expect(sent[0].startsWith("Tu salón: ")).toBe(true);
  });
});

describe("the location, at a salon with several (multi-local)", () => {
  it.each(sends)("%s: names the location, with its address under the salon's name", async (_label, send) => {
    const { service, calls } = makeService();
    await send(service, data({ locationName: "Chamberí", salonAddress: "Calle Fuencarral 120, 28010 Madrid" }));
    const { html, text } = calls[0];
    expect(html).toContain("Local:");
    expect(html).toContain("Chamberí");
    expect(html).toContain("Calle Fuencarral 120, 28010 Madrid");
    expect(text).toContain("Local: Chamberí");
    expect(text).toContain("Dirección: Calle Fuencarral 120, 28010 Madrid");
  });

  it.each(sends)("%s: no location row for a salon with one", async (_label, send) => {
    const { service, calls } = makeService();
    await send(service, data());
    expect(calls[0].html).not.toContain("Local:");
    expect(calls[0].text).not.toContain("Local:");
  });
});
