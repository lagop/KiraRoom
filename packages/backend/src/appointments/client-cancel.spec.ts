import { BadRequestException, NotFoundException } from "@nestjs/common";
import { AppointmentsService } from "./appointments.service";

/**
 * A client cancelling from the salon site's account page. The route was
 * staff-only, so it was a 403; now a client may cancel their own appointment,
 * held to the salon's minimum notice.
 */

const HOUR = 3_600_000;

function build(startsInHours: number, clientId = "client-me") {
  const start = new Date(Date.now() + startsInHours * HOUR);
  // Europe/Madrid wall clock for that instant.
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Madrid",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(start);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  const appointment = {
    id: "apt-1",
    clientId,
    status: "confirmed",
    scheduledDate: new Date(`${get("year")}-${get("month")}-${get("day")}T00:00:00.000Z`),
    scheduledTime: `${get("hour")}:${get("minute")}`,
    tenant: { minCancelHours: 24, timezone: "Europe/Madrid" },
    services: [],
  };
  const updates: any[] = [];
  const prisma: any = {
    appointment: {
      findUnique: async () => appointment,
      update: async (args: any) => { updates.push(args); return { ...appointment, ...args.data }; },
    },
  };
  const stub = {} as any;
  const service = new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
  (service as any).enrichAppointment = (a: any) => a;
  (service as any).logAppointmentActivity = async () => undefined;
  (service as any).sendAppointmentCancelledNotifications = async () => undefined;
  return { service, updates };
}

const ME = { id: "client-me", role: "client", tenantId: "t1" };

describe("a client cancelling their own appointment", () => {
  it("is allowed with enough notice", async () => {
    const { service, updates } = build(48);
    await service.cancel(ME, "apt-1");
    expect(updates[0].data.status).toBe("cancelled");
  });

  it("is refused inside the salon's notice window", async () => {
    const { service, updates } = build(3);
    await expect(service.cancel(ME, "apt-1")).rejects.toThrow(BadRequestException);
    expect(updates).toHaveLength(0);
  });

  it("cannot touch someone else's appointment", async () => {
    const { service, updates } = build(48, "someone-else");
    await expect(service.cancel(ME, "apt-1")).rejects.toThrow(NotFoundException);
    expect(updates).toHaveLength(0);
  });

  it("does not bind staff to the notice window", async () => {
    const { service, updates } = build(3);
    await service.cancel({ id: "u1", role: "owner", tenantId: "t1" }, "apt-1");
    expect(updates).toHaveLength(1);
  });
});
