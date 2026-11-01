import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { AppointmentsService } from "./appointments.service";
import { StaffBookingDto } from "./dto/book-appointment.dto";
import { OUTSIDE_HOURS, SCHEDULE_CONFLICT } from "./reschedule-check";

/**
 * Booking from the panel (POST /appointments/staff).
 *
 * - A professional could not book at all: the service compared the body's
 *   professional with `user.professionalId`, which the token never carries.
 * - A visit of several services took two requests; when the second failed
 *   the appointment stayed half-made, and a retry booked it twice.
 * - Nothing checked the professional's other appointments, their hours or
 *   the past, and there was no lock against two bookings at once.
 * - Panel bookings were stored as `source: online`.
 */

const TENANT = "tenant-b";
const ME = { id: "11111111-1111-4111-8111-111111111111", userId: "u-me", firstName: "Ana" };
const COLLEAGUE = { id: "22222222-2222-4222-8222-222222222222", userId: "u-other", firstName: "Bea" };
const CUT = "33333333-3333-4333-8333-333333333333"; // 30 min
const COLOUR = "44444444-4444-4444-8444-444444444444"; // 60 min
const ELSEWHERE = "55555555-5555-4555-8555-555555555555"; // another salon's service
const CLIENT = "66666666-6666-4666-8666-666666666666";
const DAY = "2026-12-07"; // a Monday, in the future
const MON_9_TO_17 = [{ day: "monday", openTime: "09:00", closeTime: "17:00" }];

const STAFF = { id: "u-me", role: "staff", tenantId: TENANT };
const OWNER = { id: "u-owner", role: "owner", tenantId: TENANT };

function build({
  crossBooking = false,
  workingHours = MON_9_TO_17 as unknown,
  existing = [] as Array<{
    professionalId: string;
    scheduledTime: string;
    duration: number;
    status?: string;
    service?: { bufferTime: number };
  }>,
  cleanup = { cut: 0, colour: 0 },
  failServiceRows = false,
} = {}) {
  const professionals = [
    { ...ME, tenantId: TENANT, workingHours },
    { ...COLLEAGUE, tenantId: TENANT, workingHours },
  ];
  const services = [
    { id: CUT, tenantId: TENANT, duration: 30, price: 20, currency: "EUR", bufferTime: cleanup.cut },
    { id: COLOUR, tenantId: TENANT, duration: 60, price: 50, currency: "EUR", bufferTime: cleanup.colour },
    { id: ELSEWHERE, tenantId: "tenant-a", duration: 30, price: 20, currency: "EUR" },
  ];
  // What the database holds after commit; a transaction stages its writes
  // and commits them only when its callback resolves.
  const db = {
    appointments: existing.map((e, i) => ({
      id: `old-${i}`,
      tenantId: TENANT,
      scheduledDate: new Date(`${DAY}T00:00:00.000Z`),
      status: e.status ?? "confirmed",
      client: { firstName: "Lucía", lastName: "Pérez" },
      ...e,
    })) as any[],
    serviceRows: [] as any[],
    clients: [{ id: CLIENT, tenantId: TENANT, email: "c@mail.test" }] as any[],
  };
  const locks: string[] = [];

  const reads = {
    // No time off recorded (time-off-query.ts).
    timeOff: { findMany: jest.fn(async () => []) },
    tenant: {
      findUnique: jest.fn(async () => ({
        timezone: "Europe/Madrid",
        country: "ES",
        subscriptionStatus: "active",
        allowProfessionalCrossBooking: crossBooking,
        openingHours: {},
      })),
    },
    professional: {
      findFirst: jest.fn(async ({ where }: any) =>
        professionals.find(
          (p) =>
            (where.id === undefined || p.id === where.id) &&
            (where.userId === undefined || p.userId === where.userId) &&
            p.tenantId === where.tenantId,
        ) ?? null,
      ),
      count: jest.fn(async ({ where }: any) =>
        professionals.filter((p) => p.tenantId === where.tenantId && where.id.in.includes(p.id)).length,
      ),
    },
    service: {
      findFirst: jest.fn(async ({ where }: any) =>
        services.find((s) => s.id === where.id && s.tenantId === where.tenantId) ?? null,
      ),
      findMany: jest.fn(async ({ where }: any) =>
        services.filter((s) => s.tenantId === where.tenantId && where.id.in.includes(s.id)),
      ),
      count: jest.fn(async ({ where }: any) =>
        services.filter((s) => s.tenantId === where.tenantId && where.id.in.includes(s.id)).length,
      ),
    },
    client: {
      findFirst: jest.fn(async ({ where }: any) =>
        db.clients.find((c) => c.id === where.id && c.tenantId === where.tenantId) ?? null,
      ),
      count: jest.fn(async ({ where }: any) =>
        db.clients.filter((c) => c.tenantId === where.tenantId && where.id.in.includes(c.id)).length,
      ),
    },
    appointment: {
      findMany: jest.fn(async ({ where }: any) =>
        db.appointments.filter(
          (a) =>
            a.tenantId === where.tenantId &&
            // The check asks for the professional's own appointments or their
            // services in a colleague's visit (where.OR).
            a.professionalId === (where.OR?.[0]?.professionalId ?? where.professionalId) &&
            a.status !== where.status.not,
        ),
      ),
    },
    professionalLocation: { findMany: jest.fn(async () => []) },
  };

  const prisma: any = {
    ...reads,
    $transaction: jest.fn(async (fn: any) => {
      const staged = { appointments: [] as any[], serviceRows: [] as any[] };
      const tx = {
        ...reads,
        $executeRaw: async (_s: TemplateStringsArray, key: string) => {
          locks.push(key);
          return 0;
        },
        appointment: {
          ...reads.appointment,
          create: jest.fn(async ({ data }: any) => {
            const row = { id: `apt-${db.appointments.length + staged.appointments.length + 1}`, ...data };
            staged.appointments.push(row);
            return row;
          }),
        },
        appointmentService: {
          createMany: jest.fn(async ({ data }: any) => {
            if (failServiceRows) throw new Error("insert into appointment_services failed");
            staged.serviceRows.push(...data);
            return { count: data.length };
          }),
        },
      };
      const result = await fn(tx);
      db.appointments.push(...staged.appointments);
      db.serviceRows.push(...staged.serviceRows);
      return result;
    }),
  };

  const stub = {} as any;
  const service = new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
  const notify = jest.fn(async () => ({ emailSent: false, smsSent: false }));
  (service as any).sendAppointmentCreatedNotifications = notify;
  (service as any).events = { recordOnce: jest.fn() };
  return { service, db, locks, notify, prisma };
}

const BOOKING = { clientId: CLIENT, serviceId: CUT, scheduledDate: DAY, scheduledTime: "10:00" };

describe("a professional books on their own agenda", () => {
  it("is assigned to their own professional record when the body names none", async () => {
    const { service, db } = build();

    await service.createByStaff(BOOKING as any, STAFF);

    expect(db.appointments).toHaveLength(1);
    expect(db.appointments[0].professionalId).toBe(ME.id);
  });

  it("may name themself", async () => {
    const { service, db } = build();
    await service.createByStaff({ ...BOOKING, professionalId: ME.id } as any, STAFF);
    expect(db.appointments[0].professionalId).toBe(ME.id);
  });

  it("cannot book on a colleague's agenda, in the appointment or in one of its services, unless the salon allows it", async () => {
    const off = build();
    await expect(
      off.service.createByStaff({ ...BOOKING, professionalId: COLLEAGUE.id } as any, STAFF),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      off.service.createByStaff(
        { ...BOOKING, services: [{ serviceId: CUT }, { serviceId: COLOUR, professionalId: COLLEAGUE.id }] } as any,
        STAFF,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(off.db.appointments).toHaveLength(0);

    const on = build({ crossBooking: true });
    await on.service.createByStaff({ ...BOOKING, professionalId: COLLEAGUE.id } as any, STAFF);
    expect(on.db.appointments[0].professionalId).toBe(COLLEAGUE.id);
  });

  it("is refused when the account is not linked to a professional", async () => {
    const { service, db } = build();
    await expect(
      service.createByStaff(BOOKING as any, { ...STAFF, id: "u-nobody" }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(db.appointments).toHaveLength(0);
  });

  it("does not set their own commission", async () => {
    const { service, db } = build();
    await service.createByStaff({ ...BOOKING, commissionRate: 100 } as any, STAFF);
    expect(db.appointments[0]).not.toHaveProperty("commissionRate");
  });
});

describe("an owner or manager books for any professional", () => {
  it("books on the professional they chose", async () => {
    const { service, db } = build();
    await service.createByStaff({ ...BOOKING, professionalId: COLLEAGUE.id } as any, OWNER);
    expect(db.appointments[0].professionalId).toBe(COLLEAGUE.id);
  });

  it("has to choose one", async () => {
    const { service } = build();
    await expect(service.createByStaff(BOOKING as any, OWNER)).rejects.toBeInstanceOf(BadRequestException);
  });

  it("sets the commission only when they send one", async () => {
    const set = build();
    await set.service.createByStaff({ ...BOOKING, professionalId: ME.id, commissionRate: 35 } as any, OWNER);
    expect(set.db.appointments[0].commissionRate).toBe(35);

    const unset = build();
    await unset.service.createByStaff({ ...BOOKING, professionalId: ME.id } as any, OWNER);
    expect(unset.db.appointments[0]).not.toHaveProperty("commissionRate");
  });

  it("keeps the deposit they ask for, in cents", async () => {
    const set = build();
    await set.service.createByStaff(
      { ...BOOKING, professionalId: ME.id, depositRequired: true, depositAmount: 1250 } as any,
      OWNER,
    );
    expect(set.db.appointments[0]).toMatchObject({ depositRequired: true, depositAmount: 1250 });

    const unset = build();
    await unset.service.createByStaff(
      { ...BOOKING, professionalId: ME.id, depositRequired: false, depositAmount: 1250 } as any,
      OWNER,
    );
    expect(unset.db.appointments[0]).not.toHaveProperty("depositAmount");
  });

  it("a professional's booking sets no deposit", async () => {
    const { service, db } = build();
    await service.createByStaff({ ...BOOKING, depositRequired: true, depositAmount: 500 } as any, STAFF);
    expect(db.appointments[0]).not.toHaveProperty("depositRequired");
  });
});

describe("source and lock", () => {
  it("stores panel bookings as source 'staff', not 'online'", async () => {
    const { service, db } = build();
    await service.createByStaff(BOOKING as any, STAFF);
    expect(db.appointments[0].source).toBe("staff");
  });

  it("checks and inserts under the same per-salon, per-day lock as online bookings", async () => {
    const { service, locks } = build();
    await service.createByStaff(BOOKING as any, STAFF);
    expect(locks).toEqual([`booking:${TENANT}:${DAY}`]);
  });
});

describe("a visit of several services, in one request", () => {
  const VISIT = {
    ...BOOKING,
    professionalId: ME.id,
    services: [
      { serviceId: COLOUR },
      { serviceId: CUT, professionalId: COLLEAGUE.id },
    ],
  };

  it("creates the appointment and its service rows together, timed one after the other", async () => {
    const { service, db } = build();

    await service.createByStaff(VISIT as any, OWNER);

    expect(db.appointments).toHaveLength(1);
    // 10:00 to 11:30: the colour, then the cut. Madrid is UTC+1 in December.
    // And charged for both: 50 + 20 (it used to be the colour only).
    expect(db.appointments[0]).toMatchObject({ duration: 90, endTime: "11:30", price: 70, totalAmount: 7000 });
    expect(db.serviceRows).toEqual([
      expect.objectContaining({
        appointmentId: db.appointments[0].id,
        serviceId: COLOUR,
        professionalId: ME.id,
        order: 0,
        scheduledStart: new Date(`${DAY}T09:00:00.000Z`),
        scheduledEnd: new Date(`${DAY}T10:00:00.000Z`),
      }),
      expect.objectContaining({
        serviceId: CUT,
        professionalId: COLLEAGUE.id,
        order: 1,
        scheduledStart: new Date(`${DAY}T10:00:00.000Z`),
        scheduledEnd: new Date(`${DAY}T10:30:00.000Z`),
      }),
    ]);
  });

  it("leaves nothing behind, and sends nothing, when a service row fails", async () => {
    const { service, db, notify } = build({ failServiceRows: true });

    await expect(service.createByStaff(VISIT as any, OWNER)).rejects.toThrow("appointment_services");

    expect(db.appointments).toHaveLength(0);
    expect(db.serviceRows).toHaveLength(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("refuses a service of another salon before writing anything", async () => {
    const { service, db, prisma } = build();
    await expect(
      service.createByStaff({ ...VISIT, services: [{ serviceId: CUT }, { serviceId: ELSEWHERE }] } as any, OWNER),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(db.appointments).toHaveLength(0);
  });

  it("checks each service against its own professional's agenda", async () => {
    // The colleague is busy at 11:00, when the cut would start.
    const { service, db } = build({ existing: [{ professionalId: COLLEAGUE.id, scheduledTime: "11:00", duration: 30 }] });
    await expect(service.createByStaff(VISIT as any, OWNER)).rejects.toMatchObject({
      response: { code: SCHEDULE_CONFLICT, message: "Bea ya tiene una cita con Lucía Pérez a las 11:00." },
    });
    expect(db.appointments.map((a) => a.id)).toEqual(["old-0"]);
  });
});

describe("the professional's agenda and hours", () => {
  it("refuses an overlap with another of the professional's appointments, for everyone", async () => {
    const busy = [{ professionalId: ME.id, scheduledTime: "10:15", duration: 30 }];

    const staff = build({ existing: busy });
    await expect(staff.service.createByStaff(BOOKING as any, STAFF)).rejects.toBeInstanceOf(ConflictException);

    // Not even an owner who confirmed booking outside the hours.
    const owner = build({ existing: busy });
    await expect(
      owner.service.createByStaff({ ...BOOKING, professionalId: ME.id, allowOutsideHours: true } as any, OWNER),
    ).rejects.toMatchObject({ response: { code: SCHEDULE_CONFLICT } });
    expect(owner.db.appointments).toHaveLength(1); // only the existing one
  });

  it("ignores cancelled appointments and back-to-back ones", async () => {
    const { service, db } = build({
      existing: [
        { professionalId: ME.id, scheduledTime: "10:00", duration: 30, status: "cancelled" },
        { professionalId: ME.id, scheduledTime: "09:30", duration: 30 },
      ],
    });
    await service.createByStaff(BOOKING as any, STAFF);
    expect(db.appointments.filter((a) => a.source === "staff")).toHaveLength(1);
  });

  it("keeps a professional inside the hours, whatever they send", async () => {
    const { service, db } = build();
    await expect(
      service.createByStaff({ ...BOOKING, scheduledTime: "18:00", allowOutsideHours: true } as any, STAFF),
    ).rejects.toMatchObject({ response: { code: OUTSIDE_HOURS, message: "Está fuera del horario de Ana (09:00–17:00)." } });
    expect(db.appointments).toHaveLength(0);
  });

  it("asks an owner to confirm outside the hours, and books once they do", async () => {
    const { service, db } = build();
    const late = { ...BOOKING, professionalId: ME.id, scheduledTime: "18:00" };

    await expect(service.createByStaff(late as any, OWNER)).rejects.toMatchObject({
      response: { code: OUTSIDE_HOURS },
    });
    expect(db.appointments).toHaveLength(0);

    await service.createByStaff({ ...late, allowOutsideHours: true } as any, OWNER);
    expect(db.appointments).toHaveLength(1);
  });

  it("treats the past the same way: refused for a professional, confirmed by an owner", async () => {
    const past = { ...BOOKING, scheduledDate: "2025-01-06" }; // a Monday

    const staff = build();
    await expect(staff.service.createByStaff(past as any, STAFF)).rejects.toMatchObject({
      response: { code: OUTSIDE_HOURS, message: "No se puede crear una cita en un momento que ya ha pasado." },
    });

    const owner = build();
    await owner.service.createByStaff({ ...past, professionalId: ME.id, allowOutsideHours: true } as any, OWNER);
    expect(owner.db.appointments).toHaveLength(1);
  });

  it("treats time off the same way: refused for a professional, confirmed by an owner", async () => {
    const vacation = {
      professionalId: ME.id,
      kind: "vacation",
      startDate: new Date(`${DAY}T00:00:00.000Z`),
      endDate: new Date(`${DAY}T00:00:00.000Z`),
      startTime: null,
      endTime: null,
      note: null,
    };
    // The transaction reads through the same delegate.
    const staff = build();
    staff.prisma.timeOff.findMany = jest.fn(async () => [vacation]);
    await expect(
      staff.service.createByStaff({ ...BOOKING, allowOutsideHours: true } as any, STAFF),
    ).rejects.toMatchObject({ response: { code: OUTSIDE_HOURS, message: "Ana está de vacaciones ese día." } });
    expect(staff.db.appointments).toHaveLength(0);

    const owner = build();
    owner.prisma.timeOff.findMany = jest.fn(async () => [vacation]);
    const mine = { ...BOOKING, professionalId: ME.id };
    await expect(owner.service.createByStaff(mine as any, OWNER)).rejects.toMatchObject({
      response: { code: OUTSIDE_HOURS, message: "Ana está de vacaciones ese día." },
    });
    await owner.service.createByStaff({ ...mine, allowOutsideHours: true } as any, OWNER);
    expect(owner.db.appointments).toHaveLength(1);
  });
});

describe("request validation", () => {
  const errors = (body: object) =>
    validateSync(plainToInstance(StaffBookingDto, body) as object, { whitelist: true }).map((e) => e.property).sort();

  it("accepts a professional's booking without a professional id, and a visit of several services", () => {
    expect(errors(BOOKING)).toEqual([]);
    expect(
      errors({ ...BOOKING, services: [{ serviceId: CUT }, { serviceId: COLOUR, professionalId: ME.id, isParallel: true }], allowOutsideHours: true }),
    ).toEqual([]);
  });

  it("rejects malformed services and flags", () => {
    expect(errors({ ...BOOKING, services: [{ serviceId: "cut" }] })).toEqual(["services"]);
    expect(errors({ ...BOOKING, services: [{ serviceId: CUT, professionalId: "me" }] })).toEqual(["services"]);
    expect(errors({ ...BOOKING, services: [] })).toEqual(["services"]);
    expect(errors({ ...BOOKING, services: Array(21).fill({ serviceId: CUT }) })).toEqual(["services"]);
    expect(errors({ ...BOOKING, allowOutsideHours: "yes" })).toEqual(["allowOutsideHours"]);
  });
});

describe("the cleanup time after each appointment (Service.bufferTime)", () => {
  it("refuses a booking that starts inside the cleanup after another appointment, for everyone", async () => {
    // 09:30–10:00, then 15 minutes of cleanup: 10:00 is not free yet.
    const existing = [{ professionalId: ME.id, scheduledTime: "09:30", duration: 30, service: { bufferTime: 15 } }];
    const owner = build({ existing });
    await expect(
      owner.service.createByStaff({ ...BOOKING, professionalId: ME.id, allowOutsideHours: true } as any, OWNER),
    ).rejects.toMatchObject({
      response: {
        code: SCHEDULE_CONFLICT,
        message: "Ana tiene tiempo de limpieza hasta las 10:15 después de su cita con Lucía Pérez.",
      },
    });
    expect(owner.db.appointments).toHaveLength(1);
  });

  it("with 0 minutes, back to back is still fine", async () => {
    const { service, db } = build({
      existing: [{ professionalId: ME.id, scheduledTime: "09:30", duration: 30, service: { bufferTime: 0 } }],
    });
    await service.createByStaff(BOOKING as any, STAFF);
    expect(db.appointments.filter((a) => a.source === "staff")).toHaveLength(1);
  });

  it("refuses a booking whose own cleanup would run into the next appointment", async () => {
    // The cut is 10:00–10:30 plus 15 minutes: the 10:40 client would wait.
    const { service } = build({
      cleanup: { cut: 15, colour: 0 },
      existing: [{ professionalId: ME.id, scheduledTime: "10:40", duration: 30 }],
    });
    await expect(service.createByStaff(BOOKING as any, STAFF)).rejects.toMatchObject({
      response: {
        code: SCHEDULE_CONFLICT,
        message: "Ana ya tiene una cita con Lucía Pérez a las 10:40: no quedarían los 15 min de limpieza después de esta.",
      },
    });

    const fits = build({
      cleanup: { cut: 15, colour: 0 },
      existing: [{ professionalId: ME.id, scheduledTime: "10:45", duration: 30 }],
    });
    await fits.service.createByStaff(BOOKING as any, STAFF);
    expect(fits.db.appointments.filter((a) => a.source === "staff")).toHaveLength(1);
  });

  it("a visit of several services is cleaned up once, after its last service, by whoever does it", async () => {
    // Colour (Ana) 10:00–11:00, then the cut (Bea) 11:00–11:30.
    const VISIT = {
      ...BOOKING,
      professionalId: ME.id,
      services: [{ serviceId: COLOUR }, { serviceId: CUT, professionalId: COLLEAGUE.id }],
    };
    // The colour's own cleanup does not apply mid-visit: Ana is free at 11:00.
    const midVisit = build({
      cleanup: { cut: 0, colour: 30 },
      existing: [{ professionalId: ME.id, scheduledTime: "11:00", duration: 30 }],
    });
    await midVisit.service.createByStaff(VISIT as any, OWNER);
    expect(midVisit.db.appointments).toHaveLength(2);

    // The cut's cleanup runs to 11:45 on Bea's agenda.
    const after = build({
      cleanup: { cut: 15, colour: 0 },
      existing: [{ professionalId: COLLEAGUE.id, scheduledTime: "11:40", duration: 30 }],
    });
    await expect(after.service.createByStaff(VISIT as any, OWNER)).rejects.toMatchObject({
      response: { code: SCHEDULE_CONFLICT },
    });
  });

  it("the appointment has to fit the hours; its cleanup may run past closing", async () => {
    // Ana works until 17:00: a 16:30 cut with 15 minutes of cleanup is fine.
    const { service, db } = build({ cleanup: { cut: 15, colour: 0 } });
    await service.createByStaff({ ...BOOKING, scheduledTime: "16:30" } as any, STAFF);
    expect(db.appointments.filter((a) => a.source === "staff")).toHaveLength(1);
  });
});
