import { AppointmentsController } from "./appointments.controller";
import { AppointmentsService } from "./appointments.service";

/**
 * GET /appointments/available-slots offered the public site, the widget and
 * the client portal slots inside the service's minimum notice -- the next two
 * hours by default -- which an online booking then refused with "Ese horario
 * ya no se puede reservar online". getAvailableSlots now takes
 * { onlineWindow: true } and keeps only what an online booking accepts; the
 * salon's staff still get every slot.
 */

const TENANT = "tenant-1";
const PRO = "pro-1";
const SERVICE = "svc-1";

function day(offset: number): Date {
  const d = new Date(Date.now() + offset * 86_400_000);
  return new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);
}

function build(service: Record<string, unknown> = {}) {
  const prisma: any = {
    // No time off recorded (time-off-query.ts).
    timeOff: { findMany: jest.fn(async () => []) },
    tenant: { findUnique: async () => ({ id: TENANT, openingHours: {}, timezone: "Europe/Madrid" }) },
    // No schedule recorded: no shift limit, so only the window decides.
    professional: { findMany: async () => [{ id: PRO, tenantId: TENANT, workingHours: null, isActive: true }] },
    service: {
      findFirst: async () => ({
        id: SERVICE, duration: 30, isActive: true, minAdvanceBooking: 2, maxAdvanceBooking: 30, ...service,
      }),
    },
    appointment: { findMany: async () => [] },
  };
  const stub = {} as any;
  return new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
}

const slots = (svc: AppointmentsService, date: Date, online: boolean) =>
  svc.getAvailableSlots(TENANT, date, PRO, SERVICE, 30, undefined, { onlineWindow: online });

describe("getAvailableSlots with onlineWindow", () => {
  it("changes nothing for a day well inside the window", async () => {
    const svc = build();
    expect((await slots(svc, day(5), true)).length).toBe((await slots(svc, day(5), false)).length);
  });

  it("offers nothing in the past", async () => {
    const svc = build();
    expect((await slots(svc, day(-2), false)).length).toBeGreaterThan(0);
    expect(await slots(svc, day(-2), true)).toEqual([]);
  });

  it("offers nothing beyond the service's maximum advance", async () => {
    expect(await slots(build({ maxAdvanceBooking: 30 }), day(45), true)).toEqual([]);
  });

  it("offers nothing inside the service's minimum notice", async () => {
    // 72 hours' notice: tomorrow is too soon, whatever the time.
    expect(await slots(build({ minAdvanceBooking: 72 }), day(1), true)).toEqual([]);
  });

  it("offers nothing for an inactive service", async () => {
    expect(await slots(build({ isActive: false }), day(5), true)).toEqual([]);
  });

  it("offers nothing for a service the salon does not take online; the staff still see its slots", async () => {
    const svc = build({ isOnlineBookable: false });
    expect(await slots(svc, day(5), true)).toEqual([]);
    expect((await slots(svc, day(5), false)).length).toBeGreaterThan(0);
  });

  it("offers nothing with a professional who is no longer active", async () => {
    const svc = build();
    (svc as any).prisma.professional.findMany = async () => [
      { id: PRO, tenantId: TENANT, workingHours: null, isActive: false },
    ];
    expect(await slots(svc, day(5), true)).toEqual([]);
  });

  it("offers nothing with a professional who does not perform the service; the staff still see the slots", async () => {
    // Somebody else is linked to the service, so a booking with PRO would be
    // refused (assertBookableOnline).
    const svc = build();
    const team = [
      { id: PRO, tenantId: TENANT, workingHours: null, isActive: true, services: [] },
      { id: "pro-2", tenantId: TENANT, workingHours: null, isActive: true, services: [{ serviceId: SERVICE }] },
    ];
    (svc as any).prisma.professional.findMany = async ({ where }: any) =>
      team.filter((p) => !where?.id?.in || where.id.in.includes(p.id));
    expect(await slots(svc, day(5), true)).toEqual([]);
    expect((await slots(svc, day(5), false)).length).toBeGreaterThan(0);
  });
});

describe("GET /appointments/available-slots", () => {
  function controller(staff: boolean) {
    const svc = build();
    const spy = jest.spyOn(svc, "getAvailableSlots").mockResolvedValue([] as any);
    const viewer: any = { resolve: async () => ({ tenantId: TENANT, staff }) };
    return { controller: new AppointmentsController(svc, viewer, {} as any), spy };
  }
  const query: any = { tenantId: TENANT, date: "2026-10-05", serviceId: SERVICE };

  it("applies the online window to clients and anonymous visitors", async () => {
    const { controller: c, spy } = controller(false);
    await c.getAvailableSlots({ headers: {} }, query);
    expect(spy.mock.calls[0][6]).toEqual({ onlineWindow: true });
  });

  it("shows the salon's staff every slot", async () => {
    const { controller: c, spy } = controller(true);
    await c.getAvailableSlots({ headers: {} }, query);
    expect(spy.mock.calls[0][6]).toEqual({ onlineWindow: false });
  });
});

/**
 * R19: a day past the service's maxAdvanceBooking showed "No quedan horas
 * libres este día", as if the salon were full. GET
 * /appointments/booking-window tells the page and the widget the last day.
 */
describe("publicBookingWindow", () => {
  function windowFor(service: Record<string, unknown> | null, timezone = "Europe/Madrid") {
    const prisma: any = {
      tenant: { findUnique: async () => ({ timezone }) },
      service: {
        findFirst: async ({ where }: any) =>
          service && (where.isOnlineBookable === undefined || service.isOnlineBookable !== false)
            ? { id: SERVICE, minAdvanceBooking: 2, maxAdvanceBooking: 30, ...service }
            : null,
      },
    };
    const stub = {} as any;
    return new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
  }
  const NOW = Date.parse("2026-11-04T23:30:00Z"); // 00:30 on the 5th in Madrid

  it("is the day maxAdvanceBooking days ahead, in the salon's calendar", async () => {
    await expect(windowFor({ maxAdvanceBooking: 30 }).publicBookingWindow(TENANT, SERVICE, NOW)).resolves.toEqual({
      maxAdvanceDays: 30,
      lastDay: "2026-12-05",
    });
    await expect(windowFor({ maxAdvanceBooking: 7 }, "Atlantic/Canary").publicBookingWindow(TENANT, SERVICE, NOW)).resolves.toEqual({
      maxAdvanceDays: 7,
      lastDay: "2026-11-11",
    });
  });

  it("answers only for a service offered online", async () => {
    await expect(windowFor({ isOnlineBookable: false }).publicBookingWindow(TENANT, SERVICE, NOW)).rejects.toThrow(
      "Servicio no encontrado",
    );
    await expect(windowFor(null).publicBookingWindow(TENANT, SERVICE, NOW)).rejects.toThrow("Servicio no encontrado");
  });

  it("is public and checks its ids", () => {
    expect(Reflect.getMetadata("isPublic", AppointmentsController.prototype.bookingWindow)).toBe(true);
  });
});
