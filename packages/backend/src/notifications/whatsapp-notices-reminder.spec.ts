/**
 * A client who ticked "Recibir los avisos de mi cita por WhatsApp" (or whose
 * salon turned it on from her file) gets her reminders by the salon's
 * WhatsApp template (#110): the preferences ConsentService writes are the
 * ones the scheduler reads. Real NotificationsService preference check; the
 * senders are mocks (no Meta, Twilio or Resend call).
 */
import { NotificationsScheduler } from "./notifications.scheduler";
import { NotificationsService } from "./notifications.service";
import { withNoticeChannels } from "../consent/client-notices";

const HOUR = 60 * 60 * 1000;
const NOW = new Date("2026-11-02T09:00:00.000Z");

function setup(preferences: unknown) {
  const row: any = {
    id: "appt-1",
    tenantId: "t1",
    clientId: "c1",
    createdAt: new Date(NOW.getTime() - 7 * 24 * HOUR),
    startTime: new Date(NOW.getTime() + 23 * HOUR),
    scheduledDate: new Date("2026-11-03T00:00:00.000Z"),
    scheduledTime: "10:00",
    status: "confirmed",
    reminder24hSent: false,
    reminder1hSent: false,
    reminder24hAttempts: 0,
    reminder1hAttempts: 0,
    client: { firstName: "Ana", lastName: "Gil", email: null, phone: "600 111 222" },
    professional: { firstName: "Lu", lastName: "Paz" },
    service: { name: "Corte" },
    tenant: { name: "Salón", country: "ES" },
  };
  const prisma: any = {
    appointment: {
      findMany: jest.fn(async () => (row.reminder24hSent ? [] : [{ ...row }])),
      updateMany: jest.fn(async ({ data }: any) => {
        Object.assign(row, data);
        return { count: 1 };
      }),
      update: jest.fn(async ({ data }: any) => Object.assign(row, data)),
    },
    notificationPreference: {
      findUnique: jest.fn(async () => (preferences ? { clientId: "c1", preferences } : null)),
    },
    notification: { create: jest.fn(async () => ({ id: "n1" })) },
  };
  const notifications = new NotificationsService(prisma, { emitToClient: jest.fn() } as any, {} as any);
  const templates = { sendAppointmentReminder: jest.fn(async () => ({ sent: true, messageId: "wamid.1" })) };
  const email = { isConfigured: () => true, sendAppointmentReminder: jest.fn(async () => ({ success: true })) };
  const sms = { isConfigured: () => false, sendAppointmentReminder: jest.fn() };
  const whatsapp = { isConfigured: () => false, sendAppointmentReminder: jest.fn() };
  const scheduler = new NotificationsScheduler(prisma, email as any, sms as any, whatsapp as any, notifications, templates as any);
  return { scheduler, templates, row };
}

describe("WhatsApp appointment notices reach the reminder", () => {
  it("sends the 24 h reminder by the salon's WhatsApp template once WhatsApp is on", async () => {
    const { scheduler, templates, row } = setup(withNoticeChannels({}, { whatsapp: true }));
    await scheduler.send24HourReminders(NOW);
    expect(templates.sendAppointmentReminder).toHaveBeenCalledTimes(1);
    expect(templates.sendAppointmentReminder.mock.calls[0]).toEqual([
      "t1",
      expect.objectContaining({ phone: "600 111 222", clientName: "Ana", country: "ES" }),
    ]);
    expect(row.reminder24hSent).toBe(true);
  });

  it("does not use WhatsApp for a client who has not asked for it (the default)", async () => {
    const { scheduler, templates } = setup(null);
    await scheduler.send24HourReminders(NOW);
    expect(templates.sendAppointmentReminder).not.toHaveBeenCalled();
  });
});
