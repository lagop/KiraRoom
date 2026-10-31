import { ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { assertCanReschedule, rescheduleProblem, salonDayAndTime } from "./reschedule-check";
import { AppointmentsService } from "./appointments.service";
import { AppointmentServicesService } from "./appointment-services.service";

/**
 * Moving an appointment (dragging it on the calendar, or editing it) was
 * never checked: it could land on another appointment of the same
 * professional, outside their hours or in the past. Moves are now refused
 * with the reason.
 */

const TENANT = "t1";
const DAY = "2026-11-02"; // a Monday
const NOW = new Date("2026-10-30T10:00:00Z");
const MON_9_TO_17 = [{ day: "monday", openTime: "09:00", closeTime: "17:00" }];

describe("rescheduleProblem", () => {
  const base = {
    startMinutes: 10 * 60,
    durationMinutes: 60,
    professionalShifts: [{ startMinutes: 9 * 60, endMinutes: 17 * 60 }],
    professionalName: "Ana",
    others: [],
    inPast: false,
  };

  it("a free slot inside the hours is fine", () => {
    expect(rescheduleProblem(base)).toBeNull();
  });

  it("another appointment of the professional overlapping it", () => {
    expect(rescheduleProblem({ ...base, others: [{ scheduledTime: "10:30", duration: 30, clientName: "Lucía Pérez" }] })).toBe(
      "Ana ya tiene una cita con Lucía Pérez a las 10:30.",
    );
  });

  it("back to back is not an overlap", () => {
    expect(rescheduleProblem({ ...base, others: [{ scheduledTime: "11:00", duration: 30 }, { scheduledTime: "09:00", duration: 60 }] })).toBeNull();
  });

  it("outside the professional's hours, or a day they do not work", () => {
    expect(rescheduleProblem({ ...base, startMinutes: 16 * 60 + 30 })).toMatch(/fuera del horario de Ana \(09:00–17:00\)/);
    expect(rescheduleProblem({ ...base, professionalShifts: [] })).toBe("Ana no trabaja ese día.");
  });

  it("no schedule recorded is no limit, as for online booking", () => {
    expect(rescheduleProblem({ ...base, professionalShifts: undefined, startMinutes: 7 * 60 })).toBeNull();
  });

  it("outside the salon's hours when it set them", () => {
    expect(
      rescheduleProblem({ ...base, professionalShifts: undefined, startMinutes: 7 * 60, salonWindow: { startMinutes: 9 * 60, endMinutes: 20 * 60 } }),
    ).toMatch(/fuera del horario del salón/);
  });

  it("in the past", () => {
    expect(rescheduleProblem({ ...base, inPast: true })).toMatch(/ya ha pasado/);
  });

  describe("a split day (10:00–14:00 and 17:00–20:00)", () => {
    // With one window per day the afternoon did not exist: 17:00 was refused
    // and the message named only the morning.
    const split = {
      ...base,
      professionalShifts: [
        { startMinutes: 10 * 60, endMinutes: 14 * 60 },
        { startMinutes: 17 * 60, endMinutes: 20 * 60 },
      ],
    };

    it("fits in either shift", () => {
      expect(rescheduleProblem({ ...split, startMinutes: 13 * 60 })).toBeNull();
      expect(rescheduleProblem({ ...split, startMinutes: 17 * 60 })).toBeNull();
      expect(rescheduleProblem({ ...split, startMinutes: 19 * 60 })).toBeNull();
    });

    it("not into the gap, nor across it, and the message names both shifts", () => {
      const msg = "Está fuera del horario de Ana (10:00–14:00 y 17:00–20:00).";
      expect(rescheduleProblem({ ...split, startMinutes: 13 * 60 + 30 })).toBe(msg);
      expect(rescheduleProblem({ ...split, startMinutes: 15 * 60 })).toBe(msg);
      // Starts in the gap, ends inside the afternoon.
      expect(rescheduleProblem({ ...split, startMinutes: 16 * 60 + 30 })).toBe(msg);
    });
  });
});

function prismaWith(opts: { others?: any[]; workingHours?: unknown; openingHours?: unknown }) {
  return {
    tenant: { findUnique: jest.fn(async () => ({ openingHours: opts.openingHours ?? {}, timezone: "Europe/Madrid" })) },
    professional: { findFirst: jest.fn(async () => ({ firstName: "Ana", lastName: "Prueba", workingHours: opts.workingHours ?? MON_9_TO_17 })) },
    appointment: { findMany: jest.fn(async () => opts.others ?? []) },
  };
}

describe("assertCanReschedule", () => {
  const target = { tenantId: TENANT, appointmentId: "a1", professionalId: "p1", day: DAY, time: "10:00", durationMinutes: 60 };

  it("looks at the professional's other appointments that day, not this one nor cancelled ones", async () => {
    const prisma = prismaWith({});
    await assertCanReschedule(prisma, target, NOW);
    const where = (prisma.appointment.findMany.mock.calls[0] as any)[0].where;
    expect(where).toMatchObject({ tenantId: TENANT, id: { not: "a1" }, status: { not: "cancelled" } });
    // Their own appointments, and the services they do in a colleague's visit.
    expect(where.OR).toEqual([{ professionalId: "p1" }, { services: { some: { professionalId: "p1" } } }]);
  });

  it("refuses with a 409 and the reason", async () => {
    const prisma = prismaWith({ others: [{ professionalId: "p1", scheduledTime: "10:15", duration: 45, client: { firstName: "Lucía", lastName: "Pérez" } }] });
    const err = await assertCanReschedule(prisma, target, NOW).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe("Ana ya tiene una cita con Lucía Pérez a las 10:15.");
  });

  it("an hour already gone in the salon's time zone is the past", async () => {
    const err = await assertCanReschedule(prismaWith({}), { ...target, day: "2026-10-30", time: "10:00" }, NOW).catch((e) => e);
    // 10:00 in Madrid on 30 Oct is 09:00 UTC, before NOW (10:00 UTC).
    expect(err?.message).toMatch(/ya ha pasado/);
  });

  it("reads every shift of the day from the professional's schedule", async () => {
    const workingHours = [
      { day: "monday", openTime: "17:00", closeTime: "20:00" },
      { day: "monday", openTime: "10:00", closeTime: "14:00" },
    ];
    const at = (time: string) =>
      assertCanReschedule(prismaWith({ workingHours }), { ...target, time }, NOW).then(
        () => null,
        (e) => e,
      );
    expect(await at("17:00")).toBeNull();
    expect(await at("13:00")).toBeNull();
    const err = await at("13:30");
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe("Está fuera del horario de Ana (10:00–14:00 y 17:00–20:00).");
  });

  it("the salon's day and clock for a stored instant", () => {
    expect(salonDayAndTime(new Date("2026-11-02T09:15:00Z"), "Europe/Madrid")).toEqual({ day: "2026-11-02", time: "10:15" });
  });
});

describe("moving an appointment (PATCH /appointments/:id)", () => {
  function service(opts: { others?: any[] }) {
    const appointment = {
      id: "a1",
      tenantId: TENANT,
      professionalId: "p1",
      scheduledDate: new Date(`${DAY}T00:00:00.000Z`),
      scheduledTime: "10:00",
      duration: 60,
      status: "confirmed",
      tenant: { timezone: "Europe/Madrid" },
    };
    const prisma: any = {
      ...prismaWith({ others: opts.others }),
      appointment: {
        findMany: jest.fn(async () => opts.others ?? []),
        findUnique: jest.fn(async () => appointment),
        update: jest.fn(async () => {
          throw new Error("saved");
        }),
      },
    };
    const stub = {} as any;
    const svc = new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
    jest.spyOn(svc, "findOne").mockResolvedValue(appointment as any);
    return { svc, prisma };
  }
  const owner = { id: "u1", role: "owner", tenantId: TENANT };

  it("onto another appointment: refused, nothing saved", async () => {
    const { svc, prisma } = service({ others: [{ professionalId: "p1", scheduledTime: "11:00", duration: 60, client: null }] });
    await expect(svc.update(owner, "a1", { scheduledTime: "11:00" } as any)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  // The save itself is a stub that throws (update() reports that as its own
  // error): what matters is that it was reached.
  it("onto a free slot: goes on to save", async () => {
    const { svc, prisma } = service({});
    await svc.update(owner, "a1", { scheduledTime: "12:00" } as any).catch(() => undefined);
    expect(prisma.appointment.update).toHaveBeenCalled();
  });

  it("the same day and time resent with a note is not a move", async () => {
    const { svc, prisma } = service({ others: [{ scheduledTime: "10:00", duration: 60, client: null }] });
    await svc.update(owner, "a1", { scheduledDate: DAY, scheduledTime: "10:00", notes: "x" } as any).catch(() => undefined);
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    expect(prisma.appointment.update).toHaveBeenCalled();
  });
});

describe("moving one service of a multi-service appointment (PUT /appointment-services/:id)", () => {
  function services(row: Partial<{ professionalId: string | null }>, opts: { others?: any[]; ownProfessional?: string } = {}) {
    const current = {
      professionalId: "p1",
      scheduledStart: new Date(`${DAY}T09:00:00.000Z`), // 10:00 Madrid
      scheduledEnd: new Date(`${DAY}T10:00:00.000Z`),
      appointment: { id: "a1", tenantId: TENANT, professionalId: "p1", tenant: { timezone: "Europe/Madrid" } },
      ...row,
    };
    const base = prismaWith({ others: opts.others });
    const prisma: any = {
      ...base,
      // The visit's totals are synced after the save (visit-sync.ts).
      appointment: { ...base.appointment, findUnique: jest.fn(async () => null) },
      appointmentService: {
        findFirst: jest.fn(async () => current),
        update: jest.fn(async () => ({ id: "s1" })),
      },
    };
    prisma.professional.findFirst = jest.fn(async (args: any) =>
      args.where.userId ? (opts.ownProfessional ? { id: opts.ownProfessional } : null) : { firstName: "Ana", lastName: "Prueba", workingHours: MON_9_TO_17 },
    );
    const svc = new AppointmentServicesService(prisma);
    jest.spyOn(svc, "findOne").mockResolvedValue({} as any);
    return { svc, prisma };
  }

  it("a professional cannot move a colleague's service", async () => {
    const { svc, prisma } = services({ professionalId: "p2" }, { ownProfessional: "p1" });
    await expect(
      svc.update("s1", { scheduledStart: new Date(`${DAY}T10:00:00.000Z`) } as any, { id: "u1", role: "staff", tenantId: TENANT }),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.appointmentService.update).not.toHaveBeenCalled();
  });

  it("nor hand their own to a colleague", async () => {
    const { svc } = services({}, { ownProfessional: "p1" });
    await expect(svc.update("s1", { professionalId: "p2" } as any, { id: "u1", role: "staff", tenantId: TENANT })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("onto another appointment: refused", async () => {
    const { svc, prisma } = services({}, { others: [{ professionalId: "p1", scheduledTime: "11:30", duration: 30, client: null }] });
    await expect(
      svc.update(
        "s1",
        { scheduledStart: new Date(`${DAY}T10:00:00.000Z`), scheduledEnd: new Date(`${DAY}T11:00:00.000Z`) } as any,
        { id: "u0", role: "owner", tenantId: TENANT },
      ),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.appointmentService.update).not.toHaveBeenCalled();
  });

  it("onto a free slot: saved", async () => {
    const { svc, prisma } = services({}, {});
    await svc.update(
      "s1",
      { scheduledStart: new Date(`${DAY}T12:00:00.000Z`), scheduledEnd: new Date(`${DAY}T13:00:00.000Z`) } as any,
      { id: "u0", role: "owner", tenantId: TENANT },
    );
    expect(prisma.appointmentService.update).toHaveBeenCalled();
  });
});
