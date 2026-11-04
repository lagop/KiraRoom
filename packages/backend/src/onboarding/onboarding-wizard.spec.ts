import { BadRequestException } from "@nestjs/common";
import { ServiceCategory } from "@prisma/client";
import { OnboardingService } from "./onboarding.service";

/**
 * The owner wizard's "first appointment" was stored unlike every other
 * booking: totalAmount and amountDue in euros (the analytics and the
 * multi-location report read cents, so it counted 100 times too little),
 * and "date T time" parsed in the server's timezone (UTC in production), so
 * scheduledDate carried a clock time and startTime -- what the reminder jobs
 * select on -- was an hour or two off the salon's. It also left the
 * appointment without its location.
 *
 * O1: ticking any service failed the whole submission, because the services
 * were created with category "OTHER", which the database's enum does not
 * have -- and these tests mocked createMany, so they never saw it. The mock
 * below refuses a category the Prisma enum does not list, as Postgres does.
 */

/** Before every date used below: the test booking must be in the future (O12). */
const NOW = new Date("2026-10-01T00:00:00.000Z");

function setup(
  timezone = "Europe/Madrid",
  links: any[] = [],
  opts: { existing?: any[]; sameDay?: any[]; professional?: any } = {},
) {
  let made = 0;
  const prisma: any = {
    tenant: {
      findUnique: jest.fn(async () => ({ id: "t1", currency: "EUR", timezone })),
      update: jest.fn(async () => ({})),
    },
    service: {
      findMany: jest.fn(async () =>
        opts.existing ?? [{ id: "s1", name: "Corte mujer", duration: 45, price: "25.50", isActive: true }],
      ),
      create: jest.fn(async ({ data }: any) => {
        // What Postgres does with a value its enum lacks (PrismaClientValidationError).
        if (!(Object.values(ServiceCategory) as string[]).includes(data.category)) {
          throw new Error(`Invalid value for argument category: "${data.category}". Expected ServiceCategory.`);
        }
        return { id: `s-new-${++made}` };
      }),
    },
    professional: {
      findFirst: jest.fn(async () =>
        "professional" in opts ? opts.professional : { id: "p1", firstName: "Carmen", lastName: "Sánchez" },
      ),
    },
    professionalLocation: { findMany: jest.fn(async () => links) },
    client: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => ({ id: "c1", ...data })),
    },
    appointment: {
      findMany: jest.fn(async () => opts.sameDay ?? []),
      create: jest.fn(async ({ data }: any) => ({ id: "a1", ...data })),
    },
  };
  // One transaction: the same mock, run in order (a throw rejects it all).
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  return { prisma, svc: new OnboardingService(prisma, {} as any) };
}

const FIRST = { clientName: "Lucía Ejemplo", serviceName: "Corte mujer", date: "2026-10-20", time: "10:30" };

describe("onboarding wizard: services (O1, O13)", () => {
  it("creates the services with a category the database has, as the importer files them", async () => {
    const { prisma, svc } = setup();
    const out = await svc.submitWizard(
      "t1",
      {
        services: [
          { name: "Corte de cabello", durationMinutes: 30, price: 18 },
          { name: "Manicura", durationMinutes: 45, price: 25 },
          { name: "Tratamiento facial", durationMinutes: 60, price: 55 },
          { name: "Bono especial", durationMinutes: 60, price: 90 },
        ],
      },
      NOW,
    );
    const categories = prisma.service.create.mock.calls.map((c: any) => [c[0].data.name, c[0].data.category]);
    expect(categories).toEqual([
      ["Corte de cabello", "hair"],
      ["Manicura", "nails"],
      ["Tratamiento facial", "facial"],
      ["Bono especial", "other"],
    ]);
    expect(out.saved).toEqual({ services: 4, hours: false, appointment: false });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it("creates a name once, without case, and not one the salon has", async () => {
    const { prisma, svc } = setup();
    await svc.submitWizard(
      "t1",
      {
        services: [
          { name: "Manicura", durationMinutes: 45, price: 25 },
          { name: " manicura ", durationMinutes: 30, price: 20 },
          { name: "CORTE MUJER", durationMinutes: 30, price: 20 },
        ],
      },
      NOW,
    );
    expect(prisma.service.create.mock.calls.map((c: any) => c[0].data.name)).toEqual(["Manicura"]);
  });

  it("books the test appointment on a service created in the same submission, found without case", async () => {
    const { prisma, svc } = setup("Europe/Madrid", [], { existing: [] });
    const out = await svc.submitWizard(
      "t1",
      {
        services: [{ name: "Manicura", durationMinutes: 45, price: 25 }],
        firstAppointment: { ...FIRST, serviceName: "MANICURA" },
      },
      NOW,
    );
    expect(out.saved).toEqual({ services: 1, hours: false, appointment: true });
    expect(prisma.appointment.create.mock.calls[0][0].data).toMatchObject({ serviceId: "s-new-1", serviceName: "Manicura" });
  });

  it("a failure saves nothing else: services, hours and booking are one transaction", async () => {
    const { prisma, svc } = setup();
    prisma.appointment.create.mockRejectedValueOnce(new Error("db down"));
    await expect(
      svc.submitWizard(
        "t1",
        {
          services: [{ name: "Peinado", durationMinutes: 45, price: 30 }],
          workingHours: { mon: { open: "09:00", close: "19:00" } },
          firstAppointment: FIRST,
        },
        NOW,
      ),
    ).rejects.toThrow("db down");
    // Everything ran inside the one $transaction call that failed.
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.service.create).toHaveBeenCalledTimes(1);
  });
});

describe("onboarding wizard: first appointment", () => {
  it("stores the amounts in cents, like every other booking", async () => {
    const { prisma, svc } = setup();
    await svc.submitWizard("t1", { firstAppointment: FIRST }, NOW);
    const data = prisma.appointment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ totalAmount: 2550, amountDue: 2550, price: "25.50" });
  });

  it("stores the day at UTC midnight and the start instant in the salon's timezone", async () => {
    const madrid = setup("Europe/Madrid");
    await madrid.svc.submitWizard("t1", { firstAppointment: FIRST }, NOW);
    const m = madrid.prisma.appointment.create.mock.calls[0][0].data;
    expect(m.scheduledDate.toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(m.scheduledTime).toBe("10:30");
    expect(m.startTime.toISOString()).toBe("2026-10-20T08:30:00.000Z"); // CEST, UTC+2
    expect(m.endTime).toBe("11:15");

    const canarias = setup("Atlantic/Canary");
    await canarias.svc.submitWizard("t1", { firstAppointment: { ...FIRST, date: "2026-12-01" } }, NOW);
    expect(canarias.prisma.appointment.create.mock.calls[0][0].data.startTime.toISOString()).toBe(
      "2026-12-01T10:30:00.000Z", // WET, UTC+0
    );
  });

  it("is a test booking, on a test client of its own even when a real client has that name (O5)", async () => {
    const { prisma, svc } = setup();
    prisma.client.findFirst.mockResolvedValue({ id: "real-1", isTest: false });
    await svc.submitWizard("t1", { firstAppointment: FIRST }, NOW);
    expect(prisma.client.findFirst).not.toHaveBeenCalled();
    const client = prisma.client.create.mock.calls[0][0].data;
    expect(client).toMatchObject({ firstName: "Lucía", lastName: "Ejemplo", isTest: true });
    expect(client.email).toMatch(/@placeholder\.local$/);
    expect(client.phone).toBeUndefined();
    expect(prisma.appointment.create.mock.calls[0][0].data).toMatchObject({ clientId: "c1", isTest: true });
  });

  it("goes to an active professional, preferably one who does the service (O5)", async () => {
    const { prisma, svc } = setup();
    await svc.submitWizard("t1", { firstAppointment: FIRST }, NOW);
    const [first] = prisma.professional.findFirst.mock.calls.map((c: any) => c[0].where);
    expect(first).toEqual({ tenantId: "t1", isActive: true, services: { some: { serviceId: "s1" } } });
    expect(prisma.appointment.create.mock.calls[0][0].data.professionalId).toBe("p1");
  });

  it("no active professional: not created, and says why", async () => {
    const { prisma, svc } = setup("Europe/Madrid", [], { professional: null });
    const out = await svc.submitWizard("t1", { firstAppointment: FIRST }, NOW);
    expect(out.skipped.appointment).toBe("no_staff");
    expect(out.saved.appointment).toBe(false);
    expect(prisma.appointment.create).not.toHaveBeenCalled();
  });

  it("a service the salon does not have: not created, and says why", async () => {
    const { prisma, svc } = setup();
    const out = await svc.submitWizard("t1", { firstAppointment: { ...FIRST, serviceName: "Corte de cabello" } }, NOW);
    expect(out.skipped.appointment).toBe("no_service");
    expect(prisma.appointment.create).not.toHaveBeenCalled();
  });

  it("stores the professional's location", async () => {
    const { prisma, svc } = setup("Europe/Madrid", [{ professionalId: "p1", locationId: "loc-1", isPrimary: false }]);
    await svc.submitWizard("t1", { firstAppointment: FIRST }, NOW);
    expect(prisma.appointment.create.mock.calls[0][0].data.locationId).toBe("loc-1");
  });

  it("rejects an unreadable date or time before saving any step", async () => {
    const { prisma, svc } = setup();
    await expect(
      svc.submitWizard(
        "t1",
        {
          services: [{ name: "Peinado", durationMinutes: 30, price: 15 }],
          firstAppointment: { ...FIRST, time: "25:00" },
        },
        NOW,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.service.create).not.toHaveBeenCalled();
    expect(prisma.appointment.create).not.toHaveBeenCalled();
  });

  it("rejects a date already past, before saving any step (O12)", async () => {
    const { prisma, svc } = setup();
    await expect(
      svc.submitWizard(
        "t1",
        { services: [{ name: "Peinado", durationMinutes: 30, price: 15 }], firstAppointment: FIRST },
        new Date("2026-10-20T09:00:00.000Z"), // 11:00 in Madrid: 10:30 has gone
      ),
    ).rejects.toThrow(/a partir de ahora/);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("rejects a slot the professional already has taken (O12)", async () => {
    const { prisma, svc } = setup("Europe/Madrid", [], { sameDay: [{ scheduledTime: "10:00", duration: 60 }] });
    await expect(svc.submitWizard("t1", { firstAppointment: FIRST }, NOW)).rejects.toThrow(/ya tiene una cita a las 10:00/);
    expect(prisma.appointment.findMany.mock.calls[0][0].where).toMatchObject({
      professionalId: "p1",
      status: { notIn: ["cancelled", "no_show"] },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it("a slot next to another appointment is free", async () => {
    const { prisma, svc } = setup("Europe/Madrid", [], { sameDay: [{ scheduledTime: "09:30", duration: 60 }] });
    await svc.submitWizard("t1", { firstAppointment: FIRST }, NOW);
    expect(prisma.appointment.create).toHaveBeenCalledTimes(1);
  });
});

describe("onboarding wizard: the salon's hours", () => {
  // Stored as the salon's week in the list format the settings page edits
  // and availability reads (working-hours.ts salonHoursEntries); the
  // wizard's { mon: { open, close } } used to be stored as it came, which
  // nothing read.
  it("stores the week as one entry per open day, Monday first", async () => {
    const { prisma, svc } = setup();
    const out = await svc.submitWizard(
      "t1",
      { workingHours: { sat: { open: "10:00", close: "14:00" }, mon: { open: "09:00", close: "19:00" }, sun: null } },
      NOW,
    );
    expect(prisma.tenant.update.mock.calls[0][0].data.openingHours).toEqual([
      { day: "monday", openTime: "09:00", closeTime: "19:00" },
      { day: "saturday", openTime: "10:00", closeTime: "14:00" },
    ]);
    expect(out.saved.hours).toBe(true);
  });

  it("refuses a day that closes before it opens, before saving any step", async () => {
    const { prisma, svc } = setup();
    await expect(
      svc.submitWizard(
        "t1",
        {
          services: [{ name: "Peinado", durationMinutes: 30, price: 15 }],
          workingHours: { mon: { open: "19:00", close: "09:00" } },
        },
        NOW,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.service.create).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it("stores a week sent in the list format, split days included", async () => {
    const { prisma, svc } = setup();
    const openingHours = [
      { day: "monday", openTime: "10:00", closeTime: "14:00" },
      { day: "monday", openTime: "17:00", closeTime: "20:00" },
      { day: "saturday", openTime: "10:00", closeTime: "14:00" },
    ];
    await svc.submitWizard("t1", { openingHours, workingHours: { tue: { open: "09:00", close: "19:00" } } }, NOW);
    expect(prisma.tenant.update.mock.calls[0][0].data.openingHours).toEqual(openingHours);
  });

  it("refuses overlapping shifts in the list format, before saving any step", async () => {
    const { prisma, svc } = setup();
    await expect(
      svc.submitWizard(
        "t1",
        {
          services: [{ name: "Peinado", durationMinutes: 30, price: 15 }],
          openingHours: [
            { day: "monday", openTime: "09:00", closeTime: "14:00" },
            { day: "monday", openTime: "13:00", closeTime: "18:00" },
          ],
        },
        NOW,
      ),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.service.create).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it("an all-closed week stores nothing", async () => {
    const { prisma, svc } = setup();
    const out = await svc.submitWizard("t1", { workingHours: { mon: null, sun: null } }, NOW);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(out.saved).toEqual({ services: 0, hours: false, appointment: false });
  });
});

describe("onboarding wizard: loading the saved hours (I5)", () => {
  function wizardWith(openingHours: unknown, services: any[] = []) {
    const prisma: any = {
      tenant: { findUnique: jest.fn(async () => ({ id: "t1", currency: "EUR", timezone: "Europe/Madrid", openingHours })) },
      service: { findMany: jest.fn(async () => services) },
      professional: { count: jest.fn(async () => 0) },
      appointment: { count: jest.fn(async () => 0) },
    };
    return new OnboardingService(prisma, {} as any).getWizard("t1");
  }

  it("sends the saved week so the editor starts from it", async () => {
    const week = [
      { day: "tuesday", openTime: "10:00", closeTime: "14:00" },
      { day: "saturday", openTime: "09:00", closeTime: "15:00" },
    ];
    const w = await wizardWith(week);
    expect(w.hasWorkingHours).toBe(true);
    expect(w.openingHours).toEqual(week);
  });

  it("reads the old { open, close } pair as that window every day", async () => {
    const w = await wizardWith({ open: "09:00", close: "20:00" });
    expect(w.hasWorkingHours).toBe(true);
    expect(w.openingHours).toHaveLength(7);
    expect(w.openingHours[5]).toEqual({ day: "friday", openTime: "09:00", closeTime: "20:00" });
  });

  it("no hours saved: empty, and hasWorkingHours false", async () => {
    for (const empty of [{}, [], null]) {
      const w = await wizardWith(empty);
      expect(w.hasWorkingHours).toBe(false);
      expect(w.openingHours).toEqual([]);
    }
  });

  it("lists the salon's active services for the test booking's picker (O4)", async () => {
    const w = await wizardWith([], [
      { id: "s1", name: "Corte mujer", isActive: true },
      { id: "s2", name: "Antiguo", isActive: false },
    ]);
    expect(w.services).toEqual([{ id: "s1", name: "Corte mujer" }]);
    expect(w.hasServices).toBe(true);
  });
});
