import { AppointmentsService } from "./appointments.service";

/**
 * The client's notices when an appointment is created.
 *
 * R6: a salon with one location -- almost every salon -- got a confirmation
 * email with neither its address nor its phone ("avísanos cuanto antes",
 * with no number to call).
 *
 * R3: a booking from outside the salon sends its SMS only within the daily
 * caps (public-booking-sms-cap.ts); over them the SMS is held back and the
 * booking still stands.
 */
function harness(opts: { tenant?: any; smsAllowed?: boolean; locations?: any[]; smsPlan?: boolean } = {}) {
  const smsRows: any[] = [];
  const prisma: any = {
    location: { findMany: jest.fn(async () => opts.locations ?? []) },
    tenant: {
      findUnique: jest.fn(async () => ({ street: "Calle Mayor 1", postalCode: "28013", city: "Madrid", state: "Madrid", phone: "910 000 111" })),
    },
    publicBookingSms: {
      count: jest.fn(async () => (opts.smsAllowed === false ? 999 : 0)),
      create: jest.fn(async ({ data }: any) => smsRows.push(data)),
    },
    $transaction: jest.fn(async (fn: any) => fn({ ...prisma, $executeRaw: jest.fn(async () => 0) })),
  };
  const email = { sendAppointmentConfirmation: jest.fn(async (_data: any) => ({ success: true })) };
  const sms = {
    isConfigured: () => true,
    sendAppointmentConfirmation: jest.fn(async (_data: any) => ({ success: true })),
  };
  const notifications = {
    shouldSendNotification: jest.fn(async (_c: string, _t: string, ch: string) => ch === "email" || ch === "sms"),
  };
  const stub = {} as any;
  // The plan check of the automatic SMS (audit 7 N8); none wired: as before.
  const flags =
    opts.smsPlan === undefined ? undefined : { isFeatureUnlocked: jest.fn(async () => opts.smsPlan) };
  const svc = new AppointmentsService(
    prisma, stub, notifications as any, email as any, sms as any, stub, stub,
    undefined, undefined, undefined, undefined, undefined, flags as any,
  );
  const appointment = {
    id: "apt-1",
    tenantId: "t1",
    clientId: "c1",
    locationId: null,
    scheduledDate: new Date("2026-11-09T00:00:00.000Z"),
    scheduledTime: "10:00",
    client: { firstName: "Lucía", lastName: "Pérez", email: "lucia@mail.test", phone: "+34600111222" },
    professional: { firstName: "Ana", lastName: "Martínez" },
    service: { name: "Corte" },
    tenant: opts.tenant ?? { name: "Salón Luna", language: "es" },
  };
  const send = (publicBooking: boolean) =>
    (svc as any).sendAppointmentCreatedNotifications(appointment, { publicBooking });
  return { send, email, sms, smsRows, prisma };
}

describe("the confirmation email of a salon with one location (R6)", () => {
  it("gives the salon's address and phone", async () => {
    const { send, email } = harness();
    await send(false);
    expect(email.sendAppointmentConfirmation.mock.calls[0][0]).toMatchObject({
      salonName: "Salón Luna",
      salonAddress: "Calle Mayor 1, 28013 Madrid",
      salonPhone: "910 000 111",
    });
    expect(email.sendAppointmentConfirmation.mock.calls[0][0]).not.toHaveProperty("locationName");
  });

  it("uses the tenant row the appointment already carries", async () => {
    const { send, email, prisma } = harness({
      tenant: {
        name: "Salón Luna",
        language: "es",
        street: "Rúa Nova 3",
        city: "Lugo",
        postalCode: "27001",
        state: null,
        phone: "982 000 000",
        email: "hola@salonluna.test",
        minCancelHours: 12,
        cancellationPolicy: null,
      },
    });
    await send(false);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(email.sendAppointmentConfirmation.mock.calls[0][0]).toMatchObject({
      salonAddress: "Rúa Nova 3, 27001 Lugo",
      salonPhone: "982 000 000",
      // Replies go to the salon; no policy text, so the deadline (audit 7 N5, N15).
      salonEmail: "hola@salonluna.test",
      minCancelHours: 12,
    });
  });

  it("with a policy of its own, the email does not add the deadline", async () => {
    const { send, email } = harness({
      tenant: { name: "Salón Luna", language: "es", street: null, phone: null, email: null, minCancelHours: 24, cancellationPolicy: "Avísanos un día antes." },
    });
    await send(false);
    const data = email.sendAppointmentConfirmation.mock.calls[0][0];
    expect(data).not.toHaveProperty("minCancelHours");
    expect(data).not.toHaveProperty("salonEmail");
  });
});

describe("automatic SMS only on a plan with SMS notices (audit 7 N8)", () => {
  it("a salon without sms_notifications gets the email, not the SMS", async () => {
    const { send, email, sms } = harness({ smsPlan: false });
    await send(false);
    expect(email.sendAppointmentConfirmation).toHaveBeenCalledTimes(1);
    expect(sms.sendAppointmentConfirmation).not.toHaveBeenCalled();
  });

  it("a salon with it gets both", async () => {
    const { send, email, sms } = harness({ smsPlan: true });
    await send(false);
    expect(email.sendAppointmentConfirmation).toHaveBeenCalledTimes(1);
    expect(sms.sendAppointmentConfirmation).toHaveBeenCalledTimes(1);
  });

  it("leaves out what the salon has not filled in", async () => {
    const { send, email } = harness({ tenant: { name: "Salón Luna", language: "es", street: null, city: null, phone: null } });
    await send(false);
    const data = email.sendAppointmentConfirmation.mock.calls[0][0];
    expect(data).not.toHaveProperty("salonAddress");
    expect(data).not.toHaveProperty("salonPhone");
  });
});

describe("the confirmation SMS of a public booking (R3)", () => {
  it("goes out within the caps, and the decision is recorded", async () => {
    const { send, sms, smsRows } = harness();
    const result = await send(true);
    expect(sms.sendAppointmentConfirmation).toHaveBeenCalledTimes(1);
    expect(result.smsSent).toBe(true);
    expect(smsRows).toEqual([expect.objectContaining({ tenantId: "t1", appointmentId: "apt-1", allowed: true })]);
  });

  it("is held back over the caps; the email still goes", async () => {
    const { send, sms, email, smsRows } = harness({ smsAllowed: false });
    const result = await send(true);
    expect(sms.sendAppointmentConfirmation).not.toHaveBeenCalled();
    expect(email.sendAppointmentConfirmation).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ emailSent: true, smsSent: false });
    expect(smsRows[0]).toMatchObject({ allowed: false });
  });

  it("a booking made in the panel is not counted", async () => {
    const { send, sms, prisma } = harness({ smsAllowed: false });
    await send(false);
    expect(sms.sendAppointmentConfirmation).toHaveBeenCalledTimes(1);
    expect(prisma.publicBookingSms.create).not.toHaveBeenCalled();
  });
});
