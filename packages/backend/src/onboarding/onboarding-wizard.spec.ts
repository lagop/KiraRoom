import { BadRequestException } from "@nestjs/common";
import { OnboardingService } from "./onboarding.service";

/**
 * The owner wizard's "first appointment" was stored unlike every other
 * booking: totalAmount and amountDue in euros (the analytics and the
 * multi-location report read cents, so it counted 100 times too little),
 * and "date T time" parsed in the server's timezone (UTC in production), so
 * scheduledDate carried a clock time and startTime -- what the reminder jobs
 * select on -- was an hour or two off the salon's. It also left the
 * appointment without its location.
 */

function setup(timezone = "Europe/Madrid", links: any[] = []) {
  const prisma: any = {
    tenant: {
      findUnique: jest.fn(async () => ({ id: "t1", currency: "EUR", timezone })),
      update: jest.fn(async () => ({})),
    },
    service: {
      findMany: jest.fn(async () => []),
      createMany: jest.fn(async () => ({ count: 1 })),
      findFirst: jest.fn(async () => ({ id: "s1", name: "Corte mujer", duration: 45, price: "25.50" })),
    },
    professional: { findFirst: jest.fn(async () => ({ id: "p1" })) },
    professionalLocation: { findMany: jest.fn(async () => links) },
    client: {
      findFirst: jest.fn(async () => null),
      create: jest.fn(async ({ data }: any) => ({ id: "c1", ...data })),
    },
    appointment: { create: jest.fn(async ({ data }: any) => ({ id: "a1", ...data })) },
  };
  return { prisma, svc: new OnboardingService(prisma, {} as any) };
}

const FIRST = { clientName: "Lucía Ejemplo", serviceName: "Corte mujer", date: "2026-10-20", time: "10:30" };

describe("onboarding wizard: first appointment", () => {
  it("stores the amounts in cents, like every other booking", async () => {
    const { prisma, svc } = setup();
    await svc.submitWizard("t1", { firstAppointment: FIRST });
    const data = prisma.appointment.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ totalAmount: 2550, amountDue: 2550, price: "25.50" });
  });

  it("stores the day at UTC midnight and the start instant in the salon's timezone", async () => {
    const madrid = setup("Europe/Madrid");
    await madrid.svc.submitWizard("t1", { firstAppointment: FIRST });
    const m = madrid.prisma.appointment.create.mock.calls[0][0].data;
    expect(m.scheduledDate.toISOString()).toBe("2026-10-20T00:00:00.000Z");
    expect(m.scheduledTime).toBe("10:30");
    expect(m.startTime.toISOString()).toBe("2026-10-20T08:30:00.000Z"); // CEST, UTC+2
    expect(m.endTime).toBe("11:15");

    const canarias = setup("Atlantic/Canary");
    await canarias.svc.submitWizard("t1", { firstAppointment: { ...FIRST, date: "2026-12-01" } });
    expect(canarias.prisma.appointment.create.mock.calls[0][0].data.startTime.toISOString()).toBe(
      "2026-12-01T10:30:00.000Z", // WET, UTC+0
    );
  });

  it("stores the professional's location", async () => {
    const { prisma, svc } = setup("Europe/Madrid", [{ professionalId: "p1", locationId: "loc-1", isPrimary: false }]);
    await svc.submitWizard("t1", { firstAppointment: FIRST });
    expect(prisma.appointment.create.mock.calls[0][0].data.locationId).toBe("loc-1");
  });

  it("rejects an unreadable date or time before saving any step", async () => {
    const { prisma, svc } = setup();
    await expect(
      svc.submitWizard("t1", {
        services: [{ name: "Corte", durationMinutes: 30, price: 15 }],
        firstAppointment: { ...FIRST, time: "25:00" },
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.service.createMany).not.toHaveBeenCalled();
    expect(prisma.appointment.create).not.toHaveBeenCalled();
  });
});

describe("onboarding wizard: the salon's hours", () => {
  // Stored as the salon's week in the list format the settings page edits
  // and availability reads (working-hours.ts salonHoursEntries); the
  // wizard's { mon: { open, close } } used to be stored as it came, which
  // nothing read.
  it("stores the week as one entry per open day, Monday first", async () => {
    const { prisma, svc } = setup();
    await svc.submitWizard("t1", {
      workingHours: { sat: { open: "10:00", close: "14:00" }, mon: { open: "09:00", close: "19:00" }, sun: null },
    });
    expect(prisma.tenant.update.mock.calls[0][0].data.openingHours).toEqual([
      { day: "monday", openTime: "09:00", closeTime: "19:00" },
      { day: "saturday", openTime: "10:00", closeTime: "14:00" },
    ]);
  });

  it("refuses a day that closes before it opens, before saving any step", async () => {
    const { prisma, svc } = setup();
    await expect(
      svc.submitWizard("t1", {
        services: [{ name: "Corte", durationMinutes: 30, price: 15 }],
        workingHours: { mon: { open: "19:00", close: "09:00" } },
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.service.createMany).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it("stores a week sent in the list format, split days included", async () => {
    const { prisma, svc } = setup();
    const openingHours = [
      { day: "monday", openTime: "10:00", closeTime: "14:00" },
      { day: "monday", openTime: "17:00", closeTime: "20:00" },
      { day: "saturday", openTime: "10:00", closeTime: "14:00" },
    ];
    await svc.submitWizard("t1", {
      openingHours,
      workingHours: { tue: { open: "09:00", close: "19:00" } },
    });
    expect(prisma.tenant.update.mock.calls[0][0].data.openingHours).toEqual(openingHours);
  });

  it("refuses overlapping shifts in the list format, before saving any step", async () => {
    const { prisma, svc } = setup();
    await expect(
      svc.submitWizard("t1", {
        services: [{ name: "Corte", durationMinutes: 30, price: 15 }],
        openingHours: [
          { day: "monday", openTime: "09:00", closeTime: "14:00" },
          { day: "monday", openTime: "13:00", closeTime: "18:00" },
        ],
      }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.service.createMany).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it("an all-closed week stores nothing", async () => {
    const { prisma, svc } = setup();
    await svc.submitWizard("t1", { workingHours: { mon: null, sun: null } });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });
});
