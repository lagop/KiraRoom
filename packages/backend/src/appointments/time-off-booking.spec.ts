import { ConflictException } from "@nestjs/common";
import { OUTSIDE_HOURS, SCHEDULE_CONFLICT, assertCanBook, assertCanReschedule } from "./reschedule-check";
import { AppointmentsService } from "./appointments.service";

/**
 * Booking and moving into time off or a salon closure (time-off-rules.ts).
 *
 * From the panel it is refused with the reason, as a slot outside the hours
 * is: an owner or manager may confirm it (a client who insists on coming
 * while the salon is officially closed), a professional may not, and a move
 * never. Online bookings and the receptionist never get here: they only book
 * what getAvailableSlots offers (time-off-slots.spec.ts, and
 * "online booking never books into time off" below).
 */

const TENANT = "t1";
const DAY = "2026-11-02"; // a Monday
const NOW = new Date("2026-10-30T10:00:00Z");
const MON_9_TO_17 = [{ day: "monday", openTime: "09:00", closeTime: "17:00" }];

function prismaWith(timeOff: any[], others: any[] = []) {
  return {
    tenant: { findUnique: jest.fn(async () => ({ openingHours: {}, timezone: "Europe/Madrid" })) },
    professional: { findFirst: jest.fn(async () => ({ firstName: "Ana", lastName: "Prueba", workingHours: MON_9_TO_17 })) },
    appointment: { findMany: jest.fn(async () => others) },
    timeOff: { findMany: jest.fn(async () => timeOff) },
  };
}

const row = (r: Record<string, unknown>) => ({
  professionalId: "p1",
  kind: "vacation",
  startDate: new Date(`${DAY}T00:00:00.000Z`),
  endDate: new Date(`${DAY}T00:00:00.000Z`),
  startTime: null,
  endTime: null,
  note: null,
  ...r,
});

const target = { tenantId: TENANT, professionalId: "p1", day: DAY, time: "10:00", durationMinutes: 60 };
const outcome = (p: Promise<void>): Promise<any> => p.then(() => null, (e) => e);

describe("assertCanBook with time off", () => {
  it("refuses a booking on the professional's vacation with the reason, as outside hours", async () => {
    const err = await outcome(assertCanBook(prismaWith([row({ note: "Viaje" })]), target, { now: NOW }));
    expect(err).toBeInstanceOf(ConflictException);
    // The note of someone's absence is never in it.
    expect(err.getResponse()).toMatchObject({ code: OUTSIDE_HOURS, message: "Ana está de vacaciones ese día." });
  });

  it("names a salon closure and its note", async () => {
    const closure = row({ professionalId: null, kind: "closure", note: "Navidad" });
    const err = await outcome(assertCanBook(prismaWith([closure]), target, { now: NOW }));
    expect(err.getResponse()).toMatchObject({ code: OUTSIDE_HOURS, message: "El salón está cerrado ese día (Navidad)." });
  });

  it("an owner or manager who confirmed books it anyway", async () => {
    expect(await outcome(assertCanBook(prismaWith([row({})]), target, { now: NOW, allowOutsideHours: true }))).toBeNull();
    const closure = row({ professionalId: null, kind: "closure" });
    expect(await outcome(assertCanBook(prismaWith([closure]), target, { now: NOW, allowOutsideHours: true }))).toBeNull();
  });

  it("but never on top of another appointment", async () => {
    const prisma = prismaWith([row({})], [{ professionalId: "p1", scheduledTime: "10:30", duration: 30, client: null }]);
    const err = await outcome(assertCanBook(prisma, target, { now: NOW, allowOutsideHours: true }));
    expect(err.getResponse()).toMatchObject({ code: SCHEDULE_CONFLICT });
  });

  it("a partial absence refuses only the minutes it covers", async () => {
    const doctor = prismaWith([row({ kind: "other", startTime: "10:30", endTime: "11:30" })]);
    expect((await outcome(assertCanBook(doctor, target, { now: NOW })))?.message).toBe(
      "Ana no está disponible de 10:30 a 11:30 ese día.",
    );
    expect(await outcome(assertCanBook(doctor, { ...target, time: "11:30" }, { now: NOW }))).toBeNull();
    expect(await outcome(assertCanBook(doctor, { ...target, time: "09:30" }, { now: NOW }))).toBeNull();
  });

  it("a colleague's absence is not Ana's", async () => {
    expect(await outcome(assertCanBook(prismaWith([row({ professionalId: "p2" })]), target, { now: NOW }))).toBeNull();
  });

  it("asks for this salon's rows of that day only", async () => {
    const prisma = prismaWith([]);
    await assertCanBook(prisma, target, { now: NOW });
    expect(prisma.timeOff.findMany.mock.calls[0]).toEqual([
      expect.objectContaining({
        where: {
          tenantId: TENANT,
          startDate: { lte: new Date(`${DAY}T00:00:00.000Z`) },
          endDate: { gte: new Date(`${DAY}T00:00:00.000Z`) },
        },
      }),
    ]);
  });
});

describe("assertCanReschedule with time off", () => {
  it("refuses a move into time off, with no way to confirm it", async () => {
    const err = await outcome(
      assertCanReschedule(prismaWith([row({ kind: "sick_leave" })]), { ...target, appointmentId: "a1" }, NOW),
    );
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe("Ana no está disponible ese día.");
  });

  it("refuses a move into a partial closure", async () => {
    const eve = row({ professionalId: null, kind: "closure", startTime: "14:00", endTime: "20:00" });
    const err = await outcome(assertCanReschedule(prismaWith([eve]), { ...target, appointmentId: "a1", time: "13:30" }, NOW));
    expect(err.message).toBe("El salón está cerrado de 14:00 a 20:00 ese día.");
  });
});

describe("online booking never books into time off", () => {
  // Three days ahead: inside the online window, whatever today is.
  const day = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  const SERVICE = "svc-cut";
  const PRO = "pro-ana";

  function online(timeOff: any[]) {
    const insert = jest.fn();
    const prisma: any = {
      tenant: { findUnique: jest.fn(async () => ({ id: TENANT, openingHours: {}, timezone: "Europe/Madrid" })) },
      service: {
        findFirst: jest.fn(async () => ({
          id: SERVICE,
          tenantId: TENANT,
          duration: 30,
          isActive: true,
          isOnlineBookable: true,
          minAdvanceBooking: 0,
          maxAdvanceBooking: 30,
        })),
      },
      // No schedule recorded: only time off can stop 12:00.
      professional: {
        findFirst: jest.fn(async () => ({ id: PRO, tenantId: TENANT, isActive: true })),
        findMany: jest.fn(async () => [{ id: PRO, tenantId: TENANT, isActive: true, workingHours: null, services: [] }]),
      },
      appointment: { findMany: jest.fn(async () => []) },
      timeOff: { findMany: jest.fn(async () => timeOff) },
      $transaction: jest.fn(async (fn: any) => fn({ ...prisma, $executeRaw: async () => 0 })),
    };
    const stub = {} as any;
    const service = new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
    (service as any).insertAppointment = insert.mockResolvedValue({ id: "apt-1" });
    (service as any).afterAppointmentCreated = jest.fn();
    return { service, insert };
  }

  const booking = {
    professionalId: PRO,
    serviceId: SERVICE,
    scheduledDate: day,
    scheduledTime: "12:00",
    clientInfo: { firstName: "Eva", lastName: "Ruiz", phone: "600111222" },
  };
  const closed = {
    professionalId: null,
    kind: "closure",
    startDate: new Date(`${day}T00:00:00.000Z`),
    endDate: new Date(`${day}T00:00:00.000Z`),
    startTime: null,
    endTime: null,
    note: null,
  };

  it("books a free day", async () => {
    const { service, insert } = online([]);
    await service.bookOnline(TENANT, booking as any);
    expect(insert).toHaveBeenCalledTimes(1);
  });

  it("refuses a salon closure, with nothing to confirm", async () => {
    const { service, insert } = online([closed]);
    await expect(service.bookOnline(TENANT, { ...booking, allowOutsideHours: true } as any)).rejects.toBeInstanceOf(
      ConflictException,
    );
    expect(insert).not.toHaveBeenCalled();
  });

  it("refuses the professional's absence, named or as anyone", async () => {
    const away = { ...closed, professionalId: PRO, kind: "day_off" };
    const named = online([away]);
    await expect(named.service.bookOnline(TENANT, booking as any)).rejects.toBeInstanceOf(ConflictException);
    const anyone = online([away]);
    await expect(
      anyone.service.bookOnline(TENANT, { ...booking, professionalId: undefined } as any),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(named.insert).not.toHaveBeenCalled();
    expect(anyone.insert).not.toHaveBeenCalled();
  });
});
