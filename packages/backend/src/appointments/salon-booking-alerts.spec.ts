import { SALON_BOOKING_ALERT, SalonBookingAlertsService } from "./salon-booking-alerts.service";
import { DEFAULT_PREFERENCES } from "../notifications/notification-defaults";

/**
 * Audit 7 D12: the owner and admins get an email for each online booking and
 * each cancellation a client makes herself, unless they turned it off.
 */
function harness(opts: { off?: string[]; appointment?: any; emailFails?: boolean } = {}) {
  const appointment = opts.appointment ?? {
    id: "apt-1",
    tenantId: "t1",
    scheduledDate: new Date("2026-11-20T00:00:00.000Z"),
    scheduledTime: "10:30",
    serviceName: "Corte y peinado",
    client: { firstName: "Lucía", lastName: "García" },
    service: { name: "Corte" },
    professional: { firstName: "Marta" },
    tenant: { name: "Salón Luna", timezone: "Europe/Madrid", deletedAt: null },
  };
  const users = [
    { id: "owner", email: "duena@salon.test" },
    { id: "admin", email: "admin@salon.test" },
  ];
  const prisma: any = {
    appointment: { findUnique: jest.fn(async () => appointment) },
    user: { findMany: jest.fn(async () => users) },
  };
  const email = {
    sendSalonBookingAlert: jest.fn(async () => (opts.emailFails ? { success: false, error: "down" } : { success: true })),
  };
  const notifications = {
    shouldSendNotificationForUser: jest.fn(async (userId: string, type: string, channel: string) =>
      type === SALON_BOOKING_ALERT && channel === "email" ? !(opts.off ?? []).includes(userId) : false,
    ),
  };
  const config = { get: (k: string) => (k === "APP_BASE_URL" ? "https://app.kiraroom.test/" : undefined) };
  const service = new SalonBookingAlertsService(prisma, email as any, notifications as any, config as any);
  return { service, prisma, email };
}

describe("SalonBookingAlertsService", () => {
  it("emails the owner and the admins of an online booking, with a link to it", async () => {
    const t = harness();
    expect(await t.service.notify("booked", "apt-1")).toBe(2);
    expect(t.prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: "t1", role: { in: ["owner", "admin"] }, isActive: true }) }),
    );
    expect(t.email.sendSalonBookingAlert).toHaveBeenCalledWith({
      to: "duena@salon.test",
      kind: "booked",
      tenantName: "Salón Luna",
      clientName: "Lucía García",
      serviceName: "Corte y peinado",
      professionalName: "Marta",
      date: "2026-11-20",
      time: "10:30",
      appointmentUrl: "https://app.kiraroom.test/dashboard/appointments/apt-1",
      settingsUrl: "https://app.kiraroom.test/dashboard/settings/seguridad",
    });
  });

  it("a user who turned them off gets none", async () => {
    const t = harness({ off: ["admin"] });
    expect(await t.service.notify("cancelled", "apt-1")).toBe(1);
    expect(t.email.sendSalonBookingAlert).toHaveBeenCalledTimes(1);
    expect(t.email.sendSalonBookingAlert).toHaveBeenCalledWith(expect.objectContaining({ to: "duena@salon.test", kind: "cancelled" }));
  });

  it("on by default", () => {
    expect(DEFAULT_PREFERENCES[SALON_BOOKING_ALERT].email).toBe(true);
  });

  it("never throws: a failed email, a deleted salon or a test booking is just nothing sent", async () => {
    expect(await harness({ emailFails: true }).service.notify("booked", "apt-1")).toBe(0);
    const gone = harness({ appointment: { id: "apt-1", tenantId: "t1", tenant: { deletedAt: new Date() } } });
    expect(await gone.service.notify("booked", "apt-1")).toBe(0);
    expect(gone.email.sendSalonBookingAlert).not.toHaveBeenCalled();
    const test = harness({ appointment: { id: "apt-1", tenantId: "t1", isTest: true, tenant: { deletedAt: null } } });
    expect(await test.service.notify("booked", "apt-1")).toBe(0);
    const testClient = harness({ appointment: { id: "apt-1", tenantId: "t1", client: { isTest: true }, tenant: { deletedAt: null } } });
    expect(await testClient.service.notify("cancelled", "apt-1")).toBe(0);
    expect(testClient.email.sendSalonBookingAlert).not.toHaveBeenCalled();
    const broken = harness();
    broken.prisma.appointment.findUnique.mockRejectedValueOnce(new Error("db down"));
    expect(await broken.service.notify("booked", "apt-1")).toBe(0);
  });
});
