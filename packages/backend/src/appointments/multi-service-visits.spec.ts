import { ConflictException } from "@nestjs/common";
import { AppointmentsService } from "./appointments.service";
import { AppointmentServicesService } from "./appointment-services.service";
import { SCHEDULE_CONFLICT, assertCanBook, assertCanReschedule } from "./reschedule-check";
import { SalonCopilotToolsService } from "../assistant/tools/salon-copilot-tools";

/**
 * Multi-service visits through the services that use them: availability,
 * the reschedule check, the edit form, reorder and serial/parallel, the
 * copilot's reschedule and the services' own endpoints. The figures
 * themselves are pinned in visit-totals.spec.ts.
 */

const TENANT = "t1";
const DAY = "2030-11-04"; // a Monday, Madrid on UTC+1
const DATE = new Date(`${DAY}T00:00:00.000Z`);
/** The instant at which Madrid's clock reads hh:mm that day. */
const at = (hhmm: string) => {
  const [h, m] = hhmm.split(":").map(Number);
  return new Date(Date.UTC(2030, 10, 4, h - 1, m));
};
const MONDAYS = [{ day: "monday", openTime: "09:00", closeTime: "19:00" }];
const NAMES: Record<string, string> = { ana: "Ana", bea: "Bea" };
const stub = {} as any;
const owner = { id: "u0", role: "owner", tenantId: TENANT };

/** Ana's colour at 10:00, with Bea doing the rinse after it. */
const colourWithRinse = () => ({
  id: "visit-1",
  tenantId: TENANT,
  professionalId: "ana",
  scheduledDate: DATE,
  scheduledTime: "10:00",
  duration: 75,
  status: "confirmed",
  client: { firstName: "Lucía", lastName: "Pérez" },
  services: [
    { id: "colour", professionalId: "ana", scheduledStart: null, scheduledEnd: null, isParallel: false, type: "active", status: "pending", service: { duration: 60, price: "45" } },
    { id: "rinse", professionalId: "bea", scheduledStart: null, scheduledEnd: null, isParallel: false, type: "active", status: "pending", service: { duration: 15, price: "10" } },
  ],
});

/** Reschedule-check reads: Madrid, Ana and Bea on Mondays, and these appointments. */
function salonReads(appointments: any[]) {
  return {
    // No time off recorded (time-off-query.ts).
    timeOff: { findMany: jest.fn(async () => []) },
    tenant: { findUnique: jest.fn(async () => ({ id: TENANT, openingHours: {}, timezone: "Europe/Madrid" })) },
    professional: {
      findFirst: jest.fn(async (args: any) =>
        args.where.userId ? null : { firstName: NAMES[args.where.id] ?? "X", lastName: "", workingHours: MONDAYS },
      ),
      findMany: jest.fn(async (args: any) =>
        ["ana", "bea"]
          .filter((id) => !args?.where?.id?.in || args.where.id.in.includes(id))
          .map((id) => ({ id, tenantId: TENANT, isActive: true, workingHours: MONDAYS, services: [] })),
      ),
    },
    appointment: {
      findMany: jest.fn(async (args: any) => {
        const pro = args.where.OR?.[0]?.professionalId;
        const wanted: string[] = pro === undefined ? [] : typeof pro === "string" ? [pro] : pro.in;
        return appointments.filter(
          (a) =>
            a.id !== args.where.id?.not &&
            (wanted.length === 0 ||
              wanted.includes(a.professionalId) ||
              (a.services ?? []).some((s: any) => wanted.includes(s.professionalId))),
        );
      }),
    },
  };
}

describe("availability counts every service of a visit", () => {
  it("Bea is busy during the rinse she does in Ana's visit", async () => {
    const reads = salonReads([colourWithRinse()]);
    const prisma: any = { ...reads, service: { findFirst: jest.fn(async () => ({ id: "cut", duration: 30, isActive: true })) } };
    const svc = new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
    const times = (await svc.getAvailableSlots(TENANT, DATE, "bea", "cut")).map((s: any) => s.time);
    // The rinse is 11:00-11:15: a 30-minute cut at 11:00 would clash; one at
    // 10:30 ends as the rinse starts.
    expect(times).toContain("10:00");
    expect(times).toContain("10:30");
    expect(times).not.toContain("11:00");
    expect(times).toContain("11:30");
    // The query asks for Bea's own appointments and her services in others'.
    const where = prisma.appointment.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual([
      { professionalId: { in: ["bea"] } },
      { services: { some: { professionalId: { in: ["bea"] } } } },
    ]);
  });

  it("and Ana is free again after her colour, while the rinse goes on", async () => {
    const prisma: any = {
      ...salonReads([colourWithRinse()]),
      service: { findFirst: jest.fn(async () => ({ id: "fringe", duration: 15, isActive: true })) },
    };
    const svc = new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
    const times = (await svc.getAvailableSlots(TENANT, DATE, "ana", "fringe")).map((s: any) => s.time);
    expect(times).not.toContain("10:30");
    expect(times).toContain("11:00");
  });
});

describe("the reschedule check counts every service of a visit", () => {
  it("moving something of Bea's onto the rinse she does in Ana's visit is refused", async () => {
    const prisma = salonReads([colourWithRinse()]);
    const err = await assertCanReschedule(prisma as any, {
      tenantId: TENANT,
      appointmentId: "other",
      professionalId: "bea",
      day: DAY,
      time: "10:45",
      durationMinutes: 30,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe("Bea ya tiene una cita con Lucía Pérez a las 11:00.");
  });

  it("but not onto the colour, which is Ana's", async () => {
    const prisma = salonReads([colourWithRinse()]);
    await expect(
      assertCanReschedule(prisma as any, { tenantId: TENANT, appointmentId: "other", professionalId: "bea", day: DAY, time: "10:00", durationMinutes: 60 }),
    ).resolves.toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */

/** The edit form's save over a fake database (PATCH /appointments/:id). */
function editHarness(appointment: any, catalog: any[] = [], others: any[] = []) {
  const writes: any[] = [];
  const tx: any = {
    appointmentService: {
      deleteMany: jest.fn(async (a: any) => writes.push(["deleteMany", a])),
      create: jest.fn(async (a: any) => writes.push(["create", a])),
      update: jest.fn(async (a: any) => writes.push(["update", a])),
    },
    appointment: { update: jest.fn(async (a: any) => (writes.push(["appointment", a]), { ...appointment, ...a.data })) },
  };
  const reads = salonReads(others);
  const prisma: any = {
    ...reads,
    professional: { ...reads.professional, count: jest.fn(async ({ where }: any) => where.id.in.length) },
    appointment: {
      ...salonReads(others).appointment,
      findUnique: jest.fn(async () => appointment),
      update: tx.appointment.update,
    },
    appointmentService: { deleteMany: jest.fn(), createMany: jest.fn() },
    service: {
      count: jest.fn(async ({ where }: any) => where.id.in.length),
      findMany: jest.fn(async ({ where }: any) => catalog.filter((s) => where.id.in.includes(s.id))),
    },
    $transaction: jest.fn(async (fn: any) => fn(tx)),
  };
  const svc = new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
  for (const m of ["sendAppointmentRescheduledNotifications", "logAppointmentActivity"]) (svc as any)[m] = jest.fn();
  return { svc, prisma, writes };
}

const visitRow = (over: any) => ({
  scheduledStart: null,
  scheduledEnd: null,
  isParallel: false,
  type: "active",
  status: "pending",
  notes: null,
  ...over,
});

describe("editing a visit's services (the form resends them all)", () => {
  const visit = () => ({
    id: "visit-1",
    tenantId: TENANT,
    clientId: "c1",
    serviceId: "s-colour",
    professionalId: "ana",
    scheduledDate: DATE,
    scheduledTime: "10:00",
    startTime: at("10:00"),
    duration: 60, // saved before the fix: the first service only
    endTime: "11:00",
    price: "45",
    totalAmount: 4500,
    status: "confirmed",
    paymentStatus: "pending",
    addons: [],
    tenant: { timezone: "Europe/Madrid" },
    service: { id: "s-colour", duration: 60, price: "45" },
    services: [
      visitRow({
        id: "r1", serviceId: "s-colour", professionalId: "ana", order: 0, status: "completed", notes: "Tono 7.1",
        scheduledStart: at("10:00"), scheduledEnd: at("11:00"), service: { name: "Color", duration: 60, price: "45" },
      }),
      visitRow({ id: "r2", serviceId: "s-cut", professionalId: "ana", order: 1, service: { name: "Corte", duration: 30, price: "20" } }),
    ],
  });

  it("keeps the rows it still has (times, status, notes), adds the new one, in one transaction", async () => {
    const { svc, prisma, writes } = editHarness(visit(), [{ id: "s-mask", name: "Mascarilla", duration: 15, price: "8" }]);
    await svc.update(owner, "visit-1", {
      notes: "x",
      services: [
        { serviceId: "s-colour", professionalId: "ana" },
        { serviceId: "s-cut", professionalId: "ana" },
        { serviceId: "s-mask", professionalId: "ana" },
      ],
    } as any);
    expect(prisma.appointmentService.deleteMany).not.toHaveBeenCalled();
    expect(prisma.appointmentService.createMany).not.toHaveBeenCalled();
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(writes.filter(([k]) => k === "deleteMany")).toEqual([]);
    expect(writes.filter(([k]) => k === "update")).toEqual([]); // r1 and r2 untouched
    const created = writes.filter(([k]) => k === "create").map(([, a]) => a.data);
    // The new row keeps the service as it is now (appointment-snapshot.ts).
    expect(created).toEqual([
      {
        appointmentId: "visit-1",
        serviceId: "s-mask",
        professionalId: "ana",
        isParallel: false,
        order: 2,
        serviceName: "Mascarilla",
        servicePrice: "8",
        serviceDuration: 15,
      },
    ]);
    const [, appt] = writes.find(([k]) => k === "appointment");
    // 10:00-11:00 colour, 11:00-11:30 cut, 11:30-11:45 mask.
    expect(appt.data).toMatchObject({ duration: 105, endTime: "11:45", price: 73, totalAmount: 7300 });
  });

  it("a note saved with the same services resent changes no row, and fixes the old total", async () => {
    const { svc, prisma, writes } = editHarness(visit());
    await svc.update(owner, "visit-1", {
      notes: "x",
      services: [
        { serviceId: "s-colour", professionalId: "ana" },
        { serviceId: "s-cut", professionalId: "ana" },
      ],
    } as any);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    const [, appt] = writes.find(([k]) => k === "appointment");
    expect(appt.data).toMatchObject({ duration: 90, endTime: "11:30", price: 65, totalAmount: 6500 });
  });

  it("dropping a service already completed is refused, and nothing is written", async () => {
    const { svc, writes } = editHarness(visit());
    await expect(
      svc.update(owner, "visit-1", { services: [{ serviceId: "s-cut", professionalId: "ana" }] } as any),
    ).rejects.toThrow("Color ya está completado: no se puede quitar de la cita.");
    expect(writes).toEqual([]);
  });

  it("dropping a pending one removes that row only", async () => {
    const { svc, writes } = editHarness(visit());
    await svc.update(owner, "visit-1", { services: [{ serviceId: "s-colour", professionalId: "ana" }] } as any);
    expect(writes.find(([k]) => k === "deleteMany")[1].where).toEqual({
      id: { in: ["r2"] },
      appointmentId: "visit-1",
      appointment: { tenantId: owner.tenantId },
    });
    const data = writes.find(([k]) => k === "appointment")[1].data;
    // Back to the colour alone: 60 minutes, as stored, and its price.
    expect(data).not.toHaveProperty("duration");
    expect(data).toMatchObject({ price: 45, totalAmount: 4500 });
  });

  it("moving the visit moves its stored times with it", async () => {
    const { svc, writes } = editHarness(visit());
    await svc.update(owner, "visit-1", {
      scheduledTime: "12:00",
      services: [
        { serviceId: "s-colour", professionalId: "ana" },
        { serviceId: "s-cut", professionalId: "ana" },
      ],
    } as any);
    const r1 = writes.find(([k, a]) => k === "update" && a.where.id === "r1")[1];
    expect(r1.data).toEqual({ scheduledStart: at("12:00"), scheduledEnd: at("13:00") });
    const [, appt] = writes.find(([k]) => k === "appointment");
    expect(appt.data).toMatchObject({ scheduledTime: "12:00", startTime: at("12:00"), endTime: "13:30" });
  });

  it("add-ons are stored as a plain list and charged", async () => {
    const single = { ...visit(), services: [] };
    const { svc, writes } = editHarness(single, [{ id: "s-mask", name: "Mascarilla", duration: 15, price: "8" }]);
    await svc.update(owner, "visit-1", { addons: [{ addonId: "s-mask", quantity: 2 }] } as any);
    const [, appt] = writes.find(([k]) => k === "appointment");
    // With what the add-on cost when it was added (appointment-snapshot.ts).
    expect(appt.data.addons).toEqual([{ addonId: "s-mask", quantity: 2, name: "Mascarilla", price: 8, duration: 15 }]);
    expect(appt.data).toMatchObject({ duration: 90, price: 61, totalAmount: 6100 });
  });

  it("the old {set: [...]} add-ons are read back as a list", async () => {
    const { svc } = editHarness({ ...visit(), addons: { set: [{ addonId: "s-mask", quantity: 1 }] } });
    expect((await svc.findOne(owner, "visit-1")).addons).toEqual([{ addonId: "s-mask", quantity: 1 }]);
  });
});

describe("changing the service of an appointment", () => {
  const single = () => ({
    id: "apt-1",
    tenantId: TENANT,
    clientId: "c1",
    serviceId: "s-cut",
    professionalId: "ana",
    scheduledDate: DATE,
    scheduledTime: "10:00",
    startTime: at("10:00"),
    duration: 30,
    endTime: "10:30",
    price: "20",
    totalAmount: 2000,
    status: "confirmed",
    paymentStatus: "pending",
    addons: [],
    tenant: { timezone: "Europe/Madrid" },
    service: { id: "s-cut", duration: 30, price: "20" },
    services: [],
  });
  const catalog = [{ id: "s-colour", name: "Color", duration: 90, price: "50" }];

  it("takes the new service's length, end and price", async () => {
    const { svc, writes } = editHarness(single(), catalog);
    await svc.update(owner, "apt-1", { serviceId: "s-colour" } as any);
    const [, appt] = writes.find(([k]) => k === "appointment");
    expect(appt.data).toMatchObject({ serviceId: "s-colour", duration: 90, endTime: "11:30", price: 50, totalAmount: 5000 });
  });

  it("a longer service must still fit: refused when it runs into the next appointment", async () => {
    const next = { id: "apt-2", professionalId: "ana", scheduledDate: DATE, scheduledTime: "11:00", duration: 30, client: null, services: [] };
    const { svc, writes } = editHarness(single(), catalog, [next]);
    await expect(svc.update(owner, "apt-1", { serviceId: "s-colour" } as any)).rejects.toBeInstanceOf(ConflictException);
    expect(writes).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

/** A visit on the calendar (reorder, serial/parallel): cut 10:00, colour 10:30, nails alongside. */
function calendarVisit() {
  const rows = [
    { id: "cut", serviceId: "s-cut", order: 0, professionalId: "ana", scheduledStart: at("10:00"), scheduledEnd: at("10:30"), isParallel: false, type: "active", status: "pending", service: { name: "Corte", duration: 30 } },
    { id: "colour", serviceId: "s-colour", order: 1, professionalId: "ana", scheduledStart: at("10:30"), scheduledEnd: at("11:30"), isParallel: false, type: "active", status: "pending", service: { name: "Color", duration: 60 } },
    { id: "nails", serviceId: "s-nails", order: 2, professionalId: "bea", scheduledStart: at("10:00"), scheduledEnd: at("10:45"), isParallel: true, type: "active", status: "pending", service: { name: "Uñas", duration: 45 } },
  ];
  const appointment = {
    id: "visit-1",
    tenantId: TENANT,
    professionalId: "ana",
    scheduledDate: DATE,
    // As reorder used to leave it.
    scheduledTime: at("10:00").toISOString(),
    startTime: null,
    duration: 90,
    status: "confirmed",
    tenant: { timezone: "Europe/Madrid" },
    services: rows,
  };
  const writes: any[] = [];
  const tx = {
    appointmentService: { update: jest.fn(async (a: any) => writes.push(["row", a])) },
    appointment: { update: jest.fn(async (a: any) => (writes.push(["appointment", a]), { ...appointment, ...a.data })) },
  };
  const prisma: any = {
    ...salonReads([]),
    appointmentService: { findUnique: jest.fn(async () => ({ appointmentId: "visit-1" })) },
    appointment: { ...salonReads([]).appointment, findFirst: jest.fn(async () => appointment) },
    $transaction: async (fn: any) => fn(tx),
  };
  const svc = new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
  jest.spyOn(svc as any, "sendAppointmentRescheduledNotifications").mockResolvedValue(undefined);
  return { svc, writes };
}

const clock = (d: Date) =>
  new Intl.DateTimeFormat("en-GB", { timeZone: "Europe/Madrid", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(d);

describe("reorder and serial/parallel keep the appointment on the salon's clock", () => {
  it("reorder: rows laid out in the new order, the appointment's time as HH:MM and its start instant in step", async () => {
    const { svc, writes } = calendarVisit();
    await svc.reorderVisitServices(owner, "visit-1", [
      { serviceId: "s-colour", order: 0 },
      { serviceId: "s-cut", order: 1 },
      { serviceId: "s-nails", order: 2 },
    ]);
    const rows = Object.fromEntries(writes.filter(([k]) => k === "row").map(([, a]) => [a.where.id, a.data]));
    expect(rows.colour).toMatchObject({ order: 0, scheduledStart: at("10:00"), scheduledEnd: at("11:00") });
    expect(rows.cut).toMatchObject({ order: 1, scheduledStart: at("11:00"), scheduledEnd: at("11:30") });
    expect(rows.nails).toBeUndefined(); // same place, same order
    const [, appt] = writes.find(([k]) => k === "appointment");
    expect(appt.data.scheduledTime).toBe("10:00");
    expect(appt.data.scheduledTime).toMatch(/^\d{2}:\d{2}$/);
    expect(appt.data.startTime).toEqual(at("10:00"));
    expect(appt.data).toMatchObject({ duration: 90, endTime: "11:30" });
  });

  it("serial: the nails follow the colour, and the visit gets longer", async () => {
    const { svc, writes } = calendarVisit();
    await svc.setVisitServiceMode(owner, "nails", false);
    const nails = writes.find(([k, a]) => k === "row" && a.where.id === "nails")[1].data;
    expect(nails).toMatchObject({ isParallel: false, scheduledStart: at("11:30"), scheduledEnd: at("12:15") });
    const [, appt] = writes.find(([k]) => k === "appointment");
    expect(appt.data).toMatchObject({ scheduledTime: "10:00", duration: 135, endTime: "12:15" });
    expect(clock(appt.data.startTime)).toBe("10:00");
  });

  it("the same mode again changes nothing", async () => {
    const { svc, writes } = calendarVisit();
    await svc.setVisitServiceMode(owner, "nails", true);
    expect(writes).toEqual([]);
  });

  it("a reorder naming a service the visit does not have is refused", async () => {
    const { svc, writes } = calendarVisit();
    await expect(svc.reorderVisitServices(owner, "visit-1", [{ serviceId: "s-other", order: 0 }])).rejects.toThrow(/no está en esta cita/);
    expect(writes).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */

describe("the copilot's reschedule_appointment takes the panel's path", () => {
  function copilot(status: string, others: any[]) {
    const appointment = {
      id: "apt-1",
      tenantId: TENANT,
      clientId: "c1",
      serviceId: "s-cut",
      professionalId: "ana",
      scheduledDate: DATE,
      scheduledTime: "10:00",
      startTime: at("10:00"),
      duration: 60,
      status,
      paymentStatus: "pending",
      addons: [],
      client: { firstName: "Carmen" },
      tenant: { timezone: "Europe/Madrid" },
      services: [],
    };
    const reads = salonReads(others);
    const prisma: any = {
      ...reads,
      appointment: {
        ...reads.appointment,
        findUnique: jest.fn(async () => appointment),
        findFirst: jest.fn(async () => appointment),
        update: jest.fn(async () => appointment),
      },
    };
    const appointments = new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
    for (const m of ["sendAppointmentRescheduledNotifications", "logAppointmentActivity"]) (appointments as any)[m] = jest.fn();
    const tools = new SalonCopilotToolsService(prisma, undefined, appointments);
    const run = (time: string) =>
      tools.execute(
        "reschedule_appointment",
        { appointmentId: "apt-1", newDate: DAY, newTime: time },
        { prisma, tenantId: TENANT, userId: "u0", role: "manager" },
      );
    return { run, prisma };
  }

  it("onto another appointment of the professional: refused, nothing written", async () => {
    const busy = { id: "apt-9", professionalId: "ana", scheduledDate: DATE, scheduledTime: "12:00", duration: 60, client: { firstName: "Rosa", lastName: "Gil" }, services: [] };
    const { run, prisma } = copilot("confirmed", [busy]);
    const res: any = await run("11:30");
    expect(res).toEqual({ error: "slot_unavailable", message: "Ana ya tiene una cita con Rosa Gil a las 12:00." });
    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it("onto the service a colleague's visit has her doing: refused too", async () => {
    const visit = { ...colourWithRinse(), professionalId: "bea", services: colourWithRinse().services.map((s) => ({ ...s, professionalId: s.id === "rinse" ? "ana" : "bea" })) };
    const { run, prisma } = copilot("confirmed", [visit]);
    const res: any = await run("10:30");
    expect(res.error).toBe("slot_unavailable");
    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it("a cancelled appointment is not moved", async () => {
    const { run, prisma } = copilot("cancelled", []);
    const res: any = await run("15:00");
    expect(res).toEqual({ error: "slot_unavailable", message: "Una cita cancelada no se puede mover." });
    expect(prisma.appointment.update).not.toHaveBeenCalled();
  });

  it("onto a free slot: moved, with the start the reminders read", async () => {
    const { run, prisma } = copilot("confirmed", []);
    const res: any = await run("15:00");
    expect(res.ok).toBe(true);
    const data = prisma.appointment.update.mock.calls[0][0].data;
    expect(data).toMatchObject({ scheduledTime: "15:00", startTime: at("15:00"), endTime: "16:00", reminder24hSent: false });
  });
});

/* -------------------------------------------------------------------------- */

describe("the services' own endpoints keep the appointment's totals", () => {
  it("bulk-created services: the appointment covers and charges the whole visit", async () => {
    const appointment: any = {
      id: "visit-1",
      tenantId: TENANT,
      professionalId: "ana",
      scheduledDate: DATE,
      scheduledTime: "10:00",
      startTime: at("10:00"),
      duration: 60,
      endTime: "11:00",
      price: "45",
      totalAmount: 4500,
      status: "pending",
      paymentStatus: "pending",
      addons: [],
      service: { duration: 60, price: "45" },
      tenant: { timezone: "Europe/Madrid" },
      services: [],
    };
    const prisma: any = {
      appointment: {
        findUnique: jest.fn(async () => appointment),
        findFirst: jest.fn(async () => appointment),
        update: jest.fn(async () => appointment),
      },
      service: {
        count: jest.fn(async ({ where }: any) => where.id.in.length),
        findMany: jest.fn(async ({ where }: any) =>
          where.id.in.map((id: string) => ({ id, name: id, price: id === "s-colour" ? "45" : "10", duration: id === "s-colour" ? 60 : 15 })),
        ),
      },
      professional: { count: jest.fn(async ({ where }: any) => where.id.in.length) },
      appointmentService: { create: jest.fn((a: any) => a) },
      $transaction: jest.fn(async (ops: any[]) => {
        appointment.services = [
          { id: "r1", serviceId: "s-colour", professionalId: "ana", scheduledStart: null, scheduledEnd: null, isParallel: false, type: "active", status: "pending", service: { duration: 60, price: "45" } },
          { id: "r2", serviceId: "s-rinse", professionalId: "bea", scheduledStart: null, scheduledEnd: null, isParallel: false, type: "active", status: "pending", service: { duration: 15, price: "10" } },
        ];
        return ops;
      }),
    };
    const svc = new AppointmentServicesService(prisma);
    await svc.bulkCreate("visit-1", [
      { appointmentId: "visit-1", serviceId: "s-colour", professionalId: "ana" },
      { appointmentId: "visit-1", serviceId: "s-rinse", professionalId: "bea" },
    ] as any, owner);
    expect(prisma.appointment.update).toHaveBeenCalledWith({
      where: { id: "visit-1" },
      data: { duration: 75, endTime: "11:15", price: 55, totalAmount: 5500 },
    });
  });

  it("a completed service cannot be removed", async () => {
    const prisma: any = {
      appointmentService: {
        findFirst: jest.fn(async () => ({ id: "r1", appointmentId: "visit-1", status: "completed" })),
        delete: jest.fn(),
      },
    };
    const svc = new AppointmentServicesService(prisma);
    await expect(svc.remove("r1", owner)).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.appointmentService.delete).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */

describe("lists", () => {
  function lists(rows: any[] = []) {
    const prisma: any = {
      appointment: { findMany: jest.fn(async () => rows) },
      professional: { findFirst: jest.fn() },
      client: { findFirst: jest.fn() },
    };
    return { svc: new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub), prisma };
  }

  it("pending payment: unpaid, owed visits up to today, with something left to pay", async () => {
    const { svc, prisma } = lists([
      { id: "a", totalAmount: 3000, amountPaid: 0, service: { price: 30 } },
      { id: "b", totalAmount: 3000, amountPaid: 3000, service: { price: 30 } },
    ]);
    const out = await svc.findPendingPayment(owner, {});
    const where = prisma.appointment.findMany.mock.calls[0][0].where;
    expect(where.paymentStatus).toEqual({ in: ["pending", "failed"] });
    expect(where.status).toEqual({ notIn: ["cancelled", "no_show"] });
    expect(where.scheduledDate.lte).toBeInstanceOf(Date);
    expect(out.map((a: any) => a.id)).toEqual(["a"]);
  });

  it("pending payment for a cancelled status is nothing", async () => {
    const { svc, prisma } = lists();
    expect(await svc.findPendingPayment(owner, { status: "cancelled" })).toEqual([]);
    expect(prisma.appointment.findMany).not.toHaveBeenCalled();
  });

  it("the list is bounded: a year either side by default, never more than FIND_ALL_MAX, oldest first", async () => {
    const { svc, prisma } = lists([{ id: "new" }, { id: "old" }]);
    const out = await svc.findAll(owner, {});
    const args = prisma.appointment.findMany.mock.calls[0][0];
    expect(args.take).toBe(AppointmentsService.FIND_ALL_MAX);
    expect(args.where.scheduledDate.gte).toBeInstanceOf(Date);
    expect(args.where.scheduledDate.lte).toBeInstanceOf(Date);
    expect(out.map((a: any) => a.id)).toEqual(["old", "new"]);
  });

  it("a client's history and an explicit range are not cut to the window", async () => {
    const { svc, prisma } = lists();
    await svc.findAll(owner, { clientId: "c1" });
    expect(prisma.appointment.findMany.mock.calls[0][0].where.scheduledDate).toBeUndefined();
    await svc.findAll(owner, { startDate: "2020-01-01" as any });
    expect(prisma.appointment.findMany.mock.calls[1][0].where.scheduledDate).toEqual({ gte: new Date("2020-01-01") });
  });
});

describe("a new booking's check counts other visits' services too", () => {
  it("booking Bea on top of the rinse she does in Ana's visit is a schedule conflict", async () => {
    const prisma = salonReads([colourWithRinse()]);
    await expect(
      assertCanBook(prisma as any, { tenantId: TENANT, professionalId: "bea", day: DAY, time: "11:00", durationMinutes: 30 }),
    ).rejects.toMatchObject({ response: { code: SCHEDULE_CONFLICT, message: "Bea ya tiene una cita con Lucía Pérez a las 11:00." } });
  });
});

/**
 * What an appointment was booked at stays (appointment-snapshot.ts): the
 * catalog's service changed price and length since, and editing the visit
 * used to re-price it at the new figures.
 */
describe("an edit keeps what the visit was booked at", () => {
  /** Booked a cut at 20 EUR / 30 min; the catalog now says 26 EUR / 45 min. */
  const booked = () => ({
    id: "apt-1",
    tenantId: TENANT,
    clientId: "c1",
    serviceId: "s-cut",
    professionalId: "ana",
    scheduledDate: DATE,
    scheduledTime: "10:00",
    startTime: at("10:00"),
    duration: 30,
    endTime: "10:30",
    price: "20",
    totalAmount: 2000,
    status: "confirmed",
    paymentStatus: "pending",
    addons: [{ addonId: "s-mask", quantity: 1, name: "Mascarilla", price: 5, duration: 10 }],
    serviceName: "Corte",
    servicePrice: "20",
    serviceDuration: 30,
    tenant: { timezone: "Europe/Madrid" },
    service: { id: "s-cut", name: "Corte y peinado", duration: 45, price: "26" },
    services: [],
  });
  const catalog = [
    { id: "s-cut", name: "Corte y peinado", duration: 45, price: "26" },
    { id: "s-mask", name: "Mascarilla", duration: 15, price: "8" },
    { id: "s-colour", name: "Color", duration: 90, price: "50" },
    { id: "s-gloss", name: "Brillo", duration: 5, price: "3" },
  ];

  it("a reschedule moves it and leaves its price, length and snapshot alone", async () => {
    const apt = { ...booked(), duration: 40, endTime: "10:40", price: "25", totalAmount: 2500 };
    const { svc, writes } = editHarness(apt, catalog);
    await svc.update(owner, "apt-1", { scheduledTime: "12:00", addons: apt.addons.map(({ addonId, quantity }) => ({ addonId, quantity })) } as any);
    const [, appt] = writes.find(([k]) => k === "appointment");
    // 20 + 5 (the add-on at what it cost then), 30 + 10 minutes.
    expect(appt.data).toMatchObject({ scheduledTime: "12:00", endTime: "12:40", price: 25, totalAmount: 2500 });
    expect(appt.data).not.toHaveProperty("duration");
    expect(appt.data).not.toHaveProperty("serviceName");
    expect(appt.data).not.toHaveProperty("servicePrice");
    expect(appt.data.addons).toEqual([{ addonId: "s-mask", quantity: 1, name: "Mascarilla", price: 5, duration: 10 }]);
  });

  it("a new add-on is taken at today's price, the old one keeps its own", async () => {
    const { svc, writes } = editHarness({ ...booked(), duration: 40, price: "25", totalAmount: 2500 }, catalog);
    await svc.update(owner, "apt-1", {
      addons: [
        { addonId: "s-mask", quantity: 1 },
        { addonId: "s-gloss", quantity: 2 },
      ],
    } as any);
    const [, appt] = writes.find(([k]) => k === "appointment");
    expect(appt.data.addons).toEqual([
      { addonId: "s-mask", quantity: 1, name: "Mascarilla", price: 5, duration: 10 },
      { addonId: "s-gloss", quantity: 2, name: "Brillo", price: 3, duration: 5 },
    ]);
    // 20 + 5 + 2 x 3; 30 + 10 + 2 x 5.
    expect(appt.data).toMatchObject({ price: 31, totalAmount: 3100, duration: 50 });
  });

  it("switching to another service takes that service as it is now", async () => {
    const { svc, writes } = editHarness({ ...booked(), addons: [] }, catalog);
    await svc.update(owner, "apt-1", { serviceId: "s-colour" } as any);
    const [, appt] = writes.find(([k]) => k === "appointment");
    expect(appt.data).toMatchObject({
      serviceId: "s-colour",
      serviceName: "Color",
      servicePrice: "50",
      serviceDuration: 90,
      duration: 90,
      price: 50,
      totalAmount: 5000,
    });
  });

  it("the panel is shown the visit as booked, not today's catalog", async () => {
    const { svc } = editHarness(booked(), catalog);
    const shown = await svc.findOne(owner, "apt-1");
    expect(shown.service).toMatchObject({ id: "s-cut", name: "Corte", price: "20", duration: 30 });
  });
});
