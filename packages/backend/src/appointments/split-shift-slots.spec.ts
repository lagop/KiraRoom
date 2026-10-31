import { AppointmentsService } from "./appointments.service";

/**
 * Availability with a split day (jornada partida): 10:00–14:00 and
 * 17:00–20:00, stored as two entries for the same weekday.
 *
 * Availability used to read only the first entry for a day, so the afternoon
 * shift did not exist: 17:00 was never offered. A 60-minute service also has
 * to fit inside ONE shift -- 13:30 would run into the lunch gap.
 */

const TENANT_ID = "tenant-1";
const PRO_ID = "pro-lucia";
const SERVICE_ID = "svc-color";
const MONDAY = "2026-11-02";

const SPLIT = [
  // Out of order on purpose: nothing should depend on how they were saved.
  { day: "monday", openTime: "17:00", closeTime: "20:00" },
  { day: "monday", openTime: "10:00", closeTime: "14:00" },
];

function build(
  professionals: Array<{ id: string; workingHours?: unknown }>,
  appointments: Array<{ professionalId: string; scheduledTime: string; duration: number }> = [],
) {
  const prisma: any = {
    // No time off recorded (time-off-query.ts).
    timeOff: { findMany: jest.fn(async () => []) },
    tenant: {
      // Wider than any shift, so only the shifts decide.
      findUnique: jest.fn(async () => ({
        id: TENANT_ID,
        openingHours: { open: "09:00", close: "21:00" },
        timezone: "Europe/Madrid",
      })),
    },
    professional: {
      findMany: jest.fn(async () =>
        professionals.map((p) => ({ tenantId: TENANT_ID, isActive: true, workingHours: null, ...p })),
      ),
    },
    service: {
      findFirst: jest.fn(async () => ({ id: SERVICE_ID, tenantId: TENANT_ID, duration: 60, isActive: true })),
    },
    appointment: {
      findMany: jest.fn(async () => appointments.map((a, i) => ({ id: `apt-${i}`, status: "confirmed", ...a }))),
    },
  };
  const stub = {} as any;
  return new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
}

async function named(professionalWorkingHours: unknown, appointments: any[] = []): Promise<string[]> {
  const svc = build([{ id: PRO_ID, workingHours: professionalWorkingHours }], appointments);
  const slots = await svc.getAvailableSlots(TENANT_ID, new Date(`${MONDAY}T00:00:00.000Z`), PRO_ID, SERVICE_ID);
  return slots.map((s: { time: string }) => s.time);
}

async function anyone(professionals: Array<{ id: string; workingHours?: unknown }>): Promise<string[]> {
  const svc = build(professionals);
  const slots = await svc.getAvailableSlots(TENANT_ID, new Date(`${MONDAY}T00:00:00.000Z`), undefined, SERVICE_ID);
  return slots.map((s: { time: string }) => s.time);
}

describe("getAvailableSlots with a split shift, named professional", () => {
  it("offers the last hour of the morning and the afternoon", async () => {
    const slots = await named(SPLIT);
    expect(slots).toContain("13:00");
    expect(slots).toContain("17:00");
    expect(slots).toContain("19:00");
  });

  it("does not offer a slot that runs into the lunch gap, or one inside it", async () => {
    const slots = await named(SPLIT);
    expect(slots).not.toContain("13:30");
    expect(slots).not.toContain("14:00");
    expect(slots).not.toContain("15:00");
    expect(slots).not.toContain("16:30");
    expect(slots).not.toContain("19:30");
  });

  it("is exactly the two shifts, in 30-minute steps", async () => {
    expect(await named(SPLIT)).toEqual([
      "10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00",
      "17:00", "17:30", "18:00", "18:30", "19:00",
    ]);
  });

  it("still removes an afternoon slot that is already booked", async () => {
    const slots = await named(SPLIT, [{ professionalId: PRO_ID, scheduledTime: "17:30", duration: 60 }]);
    expect(slots).not.toContain("17:00");
    expect(slots).not.toContain("18:00");
    expect(slots).toContain("18:30");
  });
});

describe("getAvailableSlots with a split shift, any professional", () => {
  it("follows the same shifts as the named path", async () => {
    expect(await anyone([{ id: PRO_ID, workingHours: SPLIT }])).toEqual(await named(SPLIT));
  });

  it("covers the gap when a colleague works through it", async () => {
    const colleague = [{ day: "monday", openTime: "14:00", closeTime: "17:00" }];
    const slots = await anyone([
      { id: PRO_ID, workingHours: SPLIT },
      { id: "pro-bea", workingHours: colleague },
    ]);
    expect(slots).toContain("15:00");
    // Neither of them can do 13:30 to 14:30 alone.
    expect(slots).not.toContain("13:30");
  });
});
