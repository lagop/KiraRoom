/**
 * Audit 5, phase 2: what a client is told about a booking made online.
 *
 * - Pending (the salon confirms by hand): "Hemos recibido tu solicitud.
 *   {Salón} te confirmará la cita" -- never "confirmada" before it is. The
 *   chat receptionist says "reservada, pendiente de que {salón} la confirme".
 * - The "Cancelar mi cita" link, in the email and the SMS.
 * - Not confirmed in time: "{Salón} no ha podido confirmar tu cita".
 */

import { EmailService, AppointmentEmailData } from "./email.service";
import { SmsService, AppointmentSmsData, smsE164 } from "./sms.service";

function email() {
  const config = { get: (key: string) => ({ RESEND_API_KEY: "re_test_key", EMAIL_FROM: "Reservas <citas@example.test>" } as any)[key] } as any;
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
  (service as any).resendKey = "re_test_key";
  return { service, calls };
}

function sms() {
  const service = new SmsService({ get: () => undefined } as any, {} as any);
  const sent: string[] = [];
  (service as any).sendSms = async ({ body }: { body: string }) => {
    sent.push(body);
    return { success: true };
  };
  return { service, sent };
}

const LINK = "https://app.example.test/public/cita/C3yfTipRTD6dih8uPUxbag.abcdefghijklmnopqrstuv";

const emailData = (o: Partial<AppointmentEmailData> = {}): AppointmentEmailData => ({
  clientName: "Ana García",
  clientEmail: "ana@example.test",
  serviceName: "Corte",
  professionalName: "Lucía Pérez",
  date: "2026-11-20",
  time: "10:30",
  salonName: "Salón Lucía",
  ...o,
});

const smsData = (o: Partial<AppointmentSmsData> = {}): AppointmentSmsData => ({
  clientName: "Ana",
  clientPhone: "600111222",
  serviceName: "Corte",
  professionalName: "Lucía",
  date: "2026-11-20",
  time: "10:30",
  salonName: "Salón Lucía",
  ...o,
});

describe("a pending booking's email", () => {
  it("says the request was received and the salon will confirm it", async () => {
    const { service, calls } = email();
    await service.sendAppointmentConfirmation(emailData({ pending: true }));
    expect(calls[0].subject).toBe("Hemos recibido tu solicitud de cita en Salón Lucía");
    for (const part of [calls[0].html, calls[0].text]) {
      expect(part).toContain("Hemos recibido tu solicitud. Salón Lucía te confirmará la cita.");
      expect(part).not.toContain("Tu cita está confirmada");
      expect(part).not.toContain("Cita confirmada");
    }
  });

  it("escapes the salon's name in the HTML", async () => {
    const { service, calls } = email();
    await service.sendAppointmentConfirmation(emailData({ pending: true, salonName: "<b>Luz</b>" }));
    expect(calls[0].html).toContain("&lt;b&gt;Luz&lt;/b&gt; te confirmará");
  });

  it("the confirmed one is unchanged without a link", async () => {
    const { service, calls } = email();
    await service.sendAppointmentConfirmation(emailData());
    expect(calls[0].subject).toBe("Tu cita en Salón Lucía está confirmada");
    expect(calls[0].html).not.toContain("Cancelar mi cita");
  });

  it("carries 'Cancelar mi cita' when given", async () => {
    const { service, calls } = email();
    await service.sendAppointmentConfirmation(emailData({ cancelUrl: LINK }));
    expect(calls[0].html).toContain(`href="${LINK}"`);
    expect(calls[0].html).toContain("Cancelar mi cita");
    expect(calls[0].text).toContain(`Cancelar mi cita: ${LINK}`);
  });
});

describe("the 'not confirmed in time' email", () => {
  it("names the salon and links to book again", async () => {
    const { service, calls } = email();
    await service.sendBookingNotConfirmed(emailData({ bookingUrl: "https://salon.example.test/reservar" }));
    expect(calls[0].subject).toBe("Salón Lucía no ha podido confirmar tu cita");
    expect(calls[0].html).toContain("Salón Lucía no ha podido confirmar tu cita a tiempo");
    expect(calls[0].text).toContain("https://salon.example.test/reservar");
  });
});

describe("booking SMS", () => {
  it("pending: received, the salon will confirm; never 'confirmada'", async () => {
    const { service, sent } = sms();
    await service.sendAppointmentConfirmation(smsData({ pending: true }));
    expect(sent[0]).toContain("Hemos recibido tu solicitud. Salón Lucía te confirmará la cita");
    expect(sent[0]).not.toMatch(/confirmada/i);
  });

  it("the link always goes whole, at the end", async () => {
    const { service, sent } = sms();
    const long = "Mechas balayage con tratamiento de keratina y corte a capas largo";
    await service.sendAppointmentConfirmation(smsData({ cancelUrl: LINK, serviceName: long }));
    await service.sendAppointmentConfirmation(smsData({ cancelUrl: LINK, pending: true, serviceName: long }));
    for (const body of sent) {
      expect(body.endsWith(`Cancelar: ${LINK}`)).toBe(true);
      // The text in front is the short form: a link makes it two SMS at most.
      expect(body.length).toBeLessThanOrEqual(160 + LINK.length);
    }
  });

  it("not confirmed in time", async () => {
    const { service, sent } = sms();
    await service.sendBookingNotConfirmed(smsData());
    expect(sent[0]).toContain("Salón Lucía no ha podido confirmar tu cita");
    expect(sent[0].length).toBeLessThanOrEqual(160);
  });
});

describe("smsE164", () => {
  it("as the SMS is sent", () => {
    expect(smsE164("600 111 222")).toBe("+34600111222");
    expect(smsE164("0033612345678")).toBe("+33612345678");
    expect(smsE164("+44 7700 900123")).toBe("+447700900123");
  });
});
