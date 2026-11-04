import { AppointmentsService, CLIENT_LINK_CANCEL_REASON } from "./appointments.service";
import { appointmentCancelToken, appointmentCancelUrl, parseAppointmentCancelToken } from "./public-cancel-link";
import { SMS_BOOKING_DIAL_CODES, reservePublicBookingSms, smsCountryAllowed } from "./public-booking-sms-cap";
import { isHoneypotHit } from "./dto/book-appointment.dto";
import { AppointmentsController } from "./appointments.controller";

/**
 * Audit 5, phase 2 (public booking):
 * - D1: a pending booking's email and SMS say the request was received, the
 *   salon will confirm it; "confirmada" (and WhatsApp) when it does.
 * - D2: booking SMS only to Spain and the EU/EEA; a hidden field for bots;
 *   pending bookings left 48 h are cancelled with a notice.
 * - D3: the signed "Cancelar mi cita" link.
 * - D4: "Cualquier profesional" from the salon page.
 */

const SECRET = ["test", "signing", "value"].join("-");
const APT = "0b7c9f4e-2a51-4c3e-9d8a-1f2e3d4c5b6a";

beforeAll(() => {
  process.env.JWT_SECRET = SECRET;
  process.env.APP_BASE_URL = "https://app.example.test";
});

describe("the cancel link token (D3)", () => {
  it("round-trips, short enough for an SMS", () => {
    const token = appointmentCancelToken(APT, SECRET);
    expect(token.length).toBeLessThanOrEqual(45);
    expect(parseAppointmentCancelToken(token, SECRET)).toBe(APT);
  });

  it("refuses a token signed with another secret, altered, or malformed", () => {
    const token = appointmentCancelToken(APT, SECRET);
    expect(parseAppointmentCancelToken(token, "other")).toBeNull();
    const [payload, sig] = token.split(".");
    const other = appointmentCancelToken("1b7c9f4e-2a51-4c3e-9d8a-1f2e3d4c5b6a", SECRET).split(".")[0];
    expect(parseAppointmentCancelToken(`${other}.${sig}`, SECRET)).toBeNull();
    expect(parseAppointmentCancelToken(payload, SECRET)).toBeNull();
    expect(parseAppointmentCancelToken(`${token}.x`, SECRET)).toBeNull();
    expect(parseAppointmentCancelToken("", SECRET)).toBeNull();
  });

  it("builds the page URL, and none without a secret", () => {
    expect(appointmentCancelUrl(APT)).toMatch(/^https:\/\/app\.example\.test\/public\/cita\/[\w-]+\.[\w-]+$/);
    expect(appointmentCancelUrl(APT, {} as any)).toBeNull();
    expect(appointmentCancelUrl("not-a-uuid")).toBeNull();
  });
});

describe("booking SMS countries (D2)", () => {
  it("Spain and the EU/EEA only", () => {
    expect(smsCountryAllowed("600111222")).toBe(true); // Spanish, no prefix
    expect(smsCountryAllowed("+34 600 111 222")).toBe(true);
    expect(smsCountryAllowed("0033612345678")).toBe(true); // France
    expect(smsCountryAllowed("+351912345678")).toBe(true); // Portugal
    expect(smsCountryAllowed("+4791234567")).toBe(true); // Norway (EEA)
    expect(smsCountryAllowed("+447700900123")).toBe(false); // UK
    expect(smsCountryAllowed("+41791234567")).toBe(false); // Switzerland
    expect(smsCountryAllowed("+35020012345")).toBe(false); // Gibraltar
    expect(smsCountryAllowed("+12025550123")).toBe(false);
    expect(smsCountryAllowed("+2348012345678")).toBe(false);
    expect(smsCountryAllowed("12345")).toBe(false);
  });

  it("no code in the list is a prefix of another", () => {
    for (const a of SMS_BOOKING_DIAL_CODES) {
      for (const b of SMS_BOOKING_DIAL_CODES) {
        if (a !== b) expect(b.startsWith(a)).toBe(false);
      }
    }
  });

  it("another country is held back and recorded, without counting", async () => {
    const rows: any[] = [];
    const db: any = {
      publicBookingSms: { create: jest.fn(async ({ data }: any) => rows.push(data)) },
      $transaction: jest.fn(),
    };
    const result = await reservePublicBookingSms(db, { tenantId: "t1", appointmentId: "a1", phone: "+12025550123" });
    expect(result).toEqual({ allowed: false, reason: "country" });
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(rows).toEqual([expect.objectContaining({ appointmentId: "a1", allowed: false })]);
    expect(JSON.stringify(rows)).not.toContain("2025550123");
  });
});

describe("the hidden field (D2)", () => {
  it("is a hit only when filled in", () => {
    expect(isHoneypotHit({})).toBe(false);
    expect(isHoneypotHit({ website: "" })).toBe(false);
    expect(isHoneypotHit({ website: "   " })).toBe(false);
    expect(isHoneypotHit({ website: "http://spam.test" })).toBe(true);
  });

  it("the public route books nothing and answers like a pending booking", async () => {
    const service = { createOnline: jest.fn() };
    const controller = new AppointmentsController(service as any, {} as any, {} as any);
    const out: any = await controller.create(
      { serviceId: "s1", scheduledDate: "2026-12-01", scheduledTime: "10:00", website: "x" } as any,
      { ip: "203.0.113.9" },
    );
    expect(service.createOnline).not.toHaveBeenCalled();
    expect(out).toMatchObject({ status: "pending", scheduledDate: "2026-12-01", scheduledTime: "10:00" });
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/);
  });
});

function notices(status: "pending" | "confirmed", source = "online", opts: { held?: boolean } = {}) {
  const prisma: any = {
    location: { findMany: jest.fn(async () => []) },
    tenant: { findUnique: jest.fn(async () => ({ phone: "910 000 111" })) },
    publicBookingSms: {
      count: jest.fn(async () => 0),
      create: jest.fn(async () => ({})),
      findFirst: jest.fn(async () => (opts.held ? { id: "r1" } : null)),
    },
    $transaction: jest.fn(async (fn: any) => fn({ ...prisma, $executeRaw: jest.fn(async () => 0) })),
  };
  const email = {
    sendAppointmentConfirmation: jest.fn(async (_d: any) => ({ success: true })),
    sendAppointmentCancellation: jest.fn(async (_d: any, _r?: string) => ({ success: true })),
    sendBookingNotConfirmed: jest.fn(async (_d: any) => ({ success: true })),
  };
  const sms = {
    isConfigured: () => true,
    sendAppointmentConfirmation: jest.fn(async (_d: any) => ({ success: true })),
    sendAppointmentCancellation: jest.fn(async (_d: any, _r?: string) => ({ success: true })),
    sendBookingNotConfirmed: jest.fn(async (_d: any) => ({ success: true })),
  };
  const whatsapp = {
    sendAppointmentConfirmation: jest.fn(async () => ({})),
    sendAppointmentCancellation: jest.fn(async () => ({})),
  };
  const notifications = {
    shouldSendNotification: jest.fn(async () => true),
    create: jest.fn(async () => ({})),
    findTenantUsers: jest.fn(async () => []),
  };
  const translations = { translate: jest.fn((_l: string, k: string) => k) };
  const stub = {} as any;
  const svc = new AppointmentsService(
    prisma, stub, notifications as any, email as any, sms as any, whatsapp as any, translations as any, stub,
  );
  const appointment = {
    id: APT,
    tenantId: "t1",
    clientId: "c1",
    status,
    source,
    serviceId: "s1",
    locationId: null,
    scheduledDate: new Date("2026-12-09T00:00:00.000Z"),
    scheduledTime: "10:00",
    client: { firstName: "Lucía", lastName: "Pérez", email: "lucia@mail.test", phone: "+34600111222" },
    professional: { firstName: "Ana", lastName: "Martínez" },
    service: { name: "Corte" },
    tenant: { name: "Salón Luna", language: "es", slug: "salon-luna" },
  };
  return { svc, email, sms, whatsapp, appointment };
}

describe("a pending online booking's notices (D1)", () => {
  it("say the request was received, carry the cancel link, and send no 'confirmada' WhatsApp", async () => {
    const { svc, email, sms, whatsapp, appointment } = notices("pending");
    await (svc as any).sendAppointmentCreatedNotifications(appointment, { publicBooking: true });
    expect(email.sendAppointmentConfirmation.mock.calls[0][0]).toMatchObject({
      pending: true,
      cancelUrl: expect.stringContaining("/public/cita/"),
    });
    expect(sms.sendAppointmentConfirmation.mock.calls[0][0]).toMatchObject({ pending: true });
    expect(whatsapp.sendAppointmentConfirmation).not.toHaveBeenCalled();
  });

  it("an auto-confirmed booking gets the confirmed texts and WhatsApp once, at creation", async () => {
    const { svc, email, whatsapp, appointment } = notices("confirmed");
    await (svc as any).sendAppointmentCreatedNotifications(appointment, { publicBooking: true });
    expect(email.sendAppointmentConfirmation.mock.calls[0][0]).not.toHaveProperty("pending");
    expect(whatsapp.sendAppointmentConfirmation).toHaveBeenCalledTimes(1);
  });

  it("a booking made in the panel carries no cancel link", async () => {
    const { svc, email, appointment } = notices("confirmed", "staff");
    await (svc as any).sendAppointmentCreatedNotifications(appointment, {});
    expect(email.sendAppointmentConfirmation.mock.calls[0][0]).not.toHaveProperty("cancelUrl");
  });

  it("when the salon confirms: 'confirmada' with the link; no SMS if they were held at booking", async () => {
    const { svc, email, sms, appointment } = notices("confirmed", "widget", { held: true });
    await (svc as any).sendAppointmentConfirmedNotifications(appointment);
    expect(email.sendAppointmentConfirmation.mock.calls[0][0]).toMatchObject({ cancelUrl: expect.any(String) });
    expect(email.sendAppointmentConfirmation.mock.calls[0][0]).not.toHaveProperty("pending");
    expect(sms.sendAppointmentConfirmation).not.toHaveBeenCalled();
  });
});

describe("a booking the salon did not confirm in time (D2)", () => {
  it("gets the 'no ha podido confirmar' notices with a link to book again", async () => {
    const { svc, email, sms, appointment } = notices("pending");
    await (svc as any).sendAppointmentCancelledNotifications(appointment, "x", { notConfirmed: true });
    expect(email.sendBookingNotConfirmed.mock.calls[0][0]).toMatchObject({
      bookingUrl: expect.stringContaining("salon-luna"),
    });
    expect(email.sendAppointmentCancellation).not.toHaveBeenCalled();
    expect(sms.sendBookingNotConfirmed).toHaveBeenCalledTimes(1);
  });

  it("no SMS when her booking SMS were held back", async () => {
    const { svc, sms, appointment } = notices("pending", "online", { held: true });
    await (svc as any).sendAppointmentCancelledNotifications(appointment, "x", { notConfirmed: true });
    expect(sms.sendBookingNotConfirmed).not.toHaveBeenCalled();
  });

  it("the job cancels each old pending online booking still ahead, through the usual path", async () => {
    const now = new Date("2026-12-01T12:00:00.000Z");
    const rows = [
      { id: "a1", tenantId: "t1", scheduledDate: new Date("2026-12-05T00:00:00Z"), scheduledTime: "10:00", tenant: { name: "Salón Luna", timezone: "Europe/Madrid" } },
      // Today, already started: left to the salon.
      { id: "a2", tenantId: "t1", scheduledDate: new Date("2026-12-01T00:00:00Z"), scheduledTime: "09:00", tenant: { name: "Salón Luna", timezone: "Europe/Madrid" } },
    ];
    const prisma: any = { appointment: { findMany: jest.fn(async () => rows) } };
    const svc = new AppointmentsService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const change = jest.spyOn(svc, "changeStatus").mockResolvedValue({} as any);
    expect(await svc.expireUnconfirmedOnlineBookings(now, 48)).toBe(1);
    const where = prisma.appointment.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ status: "pending", source: { in: ["online", "widget"] } });
    expect(where.createdAt.lte.toISOString()).toBe("2026-11-29T12:00:00.000Z");
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({ role: "system", tenantId: "t1" }),
      "a1",
      "cancelled",
      expect.objectContaining({ notConfirmed: true, reason: expect.stringContaining("Salón Luna no ha podido confirmar") }),
    );
  });
});

describe("cancelling from the link (D3)", () => {
  function linkHarness(row: any) {
    const prisma: any = { appointment: { findUnique: jest.fn(async () => row) } };
    const svc = new AppointmentsService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const change = jest.spyOn(svc, "changeStatus").mockImplementation(async () => {
      row.status = "cancelled";
      return {} as any;
    });
    return { svc, change, token: appointmentCancelToken(APT, SECRET) };
  }
  const base = () => ({
    id: APT,
    tenantId: "t1",
    status: "confirmed",
    source: "online",
    scheduledDate: new Date("2026-12-10T00:00:00.000Z"),
    scheduledTime: "10:00",
    service: { name: "Corte" },
    professional: { firstName: "Ana" },
    tenant: { name: "Salón Luna", phone: "910 000 111", timezone: "Europe/Madrid", minCancelHours: 24, deletedAt: null },
  });

  it("GET only describes", async () => {
    const { svc, change, token } = linkHarness(base());
    const info = await svc.describeCancelLink(token, new Date("2026-12-01T10:00:00Z"));
    expect(info).toMatchObject({ state: "cancellable", canCancel: true, salonName: "Salón Luna", date: "2026-12-10", time: "10:00" });
    expect(info).not.toHaveProperty("client");
    expect(change).not.toHaveBeenCalled();
  });

  it("cancels outside the salon's window, as the system, with the reason", async () => {
    const { svc, change, token } = linkHarness(base());
    const info = await svc.cancelFromLink(token, new Date("2026-12-01T10:00:00Z"));
    expect(change).toHaveBeenCalledWith(
      expect.objectContaining({ role: "system", tenantId: "t1" }),
      APT,
      "cancelled",
      { reason: CLIENT_LINK_CANCEL_REASON },
    );
    expect(info).toMatchObject({ state: "cancelled", canCancel: false });
  });

  it("inside minCancelHours nothing changes: call the salon", async () => {
    const { svc, change, token } = linkHarness(base());
    const info = await svc.cancelFromLink(token, new Date("2026-12-09T12:00:00Z"));
    expect(change).not.toHaveBeenCalled();
    expect(info).toMatchObject({ state: "too_late", canCancel: false, salonPhone: "910 000 111" });
  });

  it("past or finished: closed", async () => {
    const { svc, token } = linkHarness({ ...base(), status: "completed" });
    expect(await svc.describeCancelLink(token, new Date("2026-12-01T10:00:00Z"))).toMatchObject({ state: "closed" });
    const late = linkHarness(base());
    expect(await late.svc.describeCancelLink(late.token, new Date("2026-12-11T10:00:00Z"))).toMatchObject({ state: "closed" });
  });

  it("a bad token, a panel appointment or a deleted salon: not found", async () => {
    const { svc } = linkHarness(base());
    expect(await svc.describeCancelLink("nope.nope")).toBeNull();
    const staff = linkHarness({ ...base(), source: "staff" });
    expect(await staff.svc.describeCancelLink(staff.token)).toBeNull();
    const gone = linkHarness({ ...base(), tenant: { ...base().tenant, deletedAt: new Date() } });
    expect(await gone.svc.describeCancelLink(gone.token)).toBeNull();
  });
});

describe("'Cualquier profesional' from the salon page (D4)", () => {
  function onlineHarness(tenant: any) {
    const prisma: any = {
      tenant: { findFirst: jest.fn(async () => tenant) },
      widgetInstance: { findUnique: jest.fn() },
    };
    const svc = new AppointmentsService(prisma, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const book = jest.spyOn(svc, "bookOnline").mockResolvedValue({ id: "x" } as any);
    return { svc, book, prisma };
  }

  it("books in the page's salon, across its team", async () => {
    const { svc, book, prisma } = onlineHarness({ id: "t1" });
    await svc.createOnline({ tenantId: "t1", serviceId: "s1", professionalId: "" } as any, { ip: "x" });
    expect(prisma.tenant.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "t1", deletedAt: null } }));
    expect(book).toHaveBeenCalledWith("t1", expect.anything(), [], { ip: "x" });
  });

  it("refuses an unknown or deleted salon, and no salon at all", async () => {
    const { svc } = onlineHarness(null);
    await expect(svc.createOnline({ tenantId: "t9", serviceId: "s1" } as any)).rejects.toThrow("Salón no encontrado");
    await expect(svc.createOnline({ serviceId: "s1" } as any)).rejects.toThrow("Elige un profesional");
  });
});
