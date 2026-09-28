import { AppointmentsController } from "./appointments.controller";
import { AppointmentsService } from "./appointments.service";

/**
 * GET /appointments/available-slots offered the public site, the widget and
 * the client portal slots inside the service's minimum notice -- the next two
 * hours by default -- which createOnline then refused with "Ese horario ya no
 * se puede reservar online". Clients now see only what they can book; the
 * salon's staff still see every slot, since they may book at short notice.
 */

function inHours(h: number): { day: string; time: string } {
  // Madrid wall clock, rounded down to the half hour.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(Date.now() + h * 3_600_000));
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const minute = Number(get("minute")) < 30 ? "00" : "30";
  return { day: `${get("year")}-${get("month")}-${get("day")}`, time: `${get("hour")}:${minute}` };
}

function build(service: any = { minAdvanceBooking: 2, maxAdvanceBooking: 30 }) {
  const prisma: any = {
    tenant: { findUnique: async () => ({ timezone: "Europe/Madrid" }) },
    service: { findFirst: async () => service },
  };
  const stub = {} as any;
  return new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
}

describe("restrictToOnlineWindow", () => {
  it("marks slots inside the minimum notice unavailable, and keeps the rest", async () => {
    const soon = inHours(1);
    const later = inHours(5);
    const svc = build();
    // Same day only when both fall on it; otherwise test each on its own day.
    const out = await svc.restrictToOnlineWindow("t1", "svc", soon.day, [{ time: soon.time, isAvailable: true }]);
    expect(out[0].isAvailable).toBe(false);

    const ok = await svc.restrictToOnlineWindow("t1", "svc", later.day, [{ time: later.time, isAvailable: true }]);
    expect(ok[0].isAvailable).toBe(true);
  });

  it("never offers the past, even without a service", async () => {
    const past = inHours(-3);
    const out = await build().restrictToOnlineWindow("t1", undefined, past.day, [{ time: past.time, isAvailable: true }]);
    expect(out[0].isAvailable).toBe(false);
  });

  it("does not offer a day beyond the maximum advance", async () => {
    const far = inHours(24 * 40);
    const out = await build().restrictToOnlineWindow("t1", "svc", far.day, [{ time: "10:00", isAvailable: true }]);
    expect(out[0].isAvailable).toBe(false);
  });

  it("offers nothing for a service that is not an active service of the salon", async () => {
    const later = inHours(5);
    const out = await build(null).restrictToOnlineWindow("t1", "svc", later.day, [{ time: later.time, isAvailable: true }]);
    expect(out[0].isAvailable).toBe(false);
  });
});

describe("GET /appointments/available-slots", () => {
  const soon = inHours(1);
  const query: any = { tenantId: "t1", date: soon.day, serviceId: "svc" };

  function controller(staff: boolean) {
    const svc = build();
    jest.spyOn(svc, "getAvailableSlots").mockResolvedValue([{ time: soon.time, isAvailable: true }] as any);
    const viewer: any = { resolve: async () => ({ tenantId: "t1", staff }) };
    return new AppointmentsController(svc, viewer);
  }

  it("applies the online window to clients and anonymous visitors", async () => {
    const out: any = await controller(false).getAvailableSlots({ headers: {} }, query);
    expect(out[0].isAvailable).toBe(false);
  });

  it("shows the salon's staff every slot", async () => {
    const out: any = await controller(true).getAvailableSlots({ headers: {} }, query);
    expect(out[0].isAvailable).toBe(true);
  });
});
