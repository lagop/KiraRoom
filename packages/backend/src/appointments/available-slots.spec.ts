import { AppointmentsService } from "./appointments.service";

/**
 * `getAvailableSlots` end to end, with the test salon's real configuration.
 *
 * The public booking page did not call this at all: it generated slots in the
 * browser, every half hour from 09:00 to 19:30, all flagged available "for
 * demo purposes". So a client could be offered 19:30 on a day the salon shuts
 * at 18:00, or a slot somebody else already had.
 *
 * This endpoint did check appointment overlaps and the service's real
 * duration, but it never read `professionals.workingHours` — the one place the
 * onboarding wizard writes a schedule. These cases pin both halves.
 */

// Exactly what the test salon holds: the wizard wrote Monday to Friday onto
// the professional, and left the tenant's openingHours as {}.
const CARLA_HOURS = [
  { day: "monday", openTime: "09:00", closeTime: "18:00" },
  { day: "tuesday", openTime: "09:00", closeTime: "19:00" },
  { day: "wednesday", openTime: "09:00", closeTime: "19:00" },
  { day: "thursday", openTime: "09:00", closeTime: "19:00" },
  { day: "friday", openTime: "09:00", closeTime: "19:00" },
];

const TENANT_ID = "tenant-1";
const PRO_ID = "pro-carla";
const SERVICE_ID = "svc-corte";

function build({
  workingHours = CARLA_HOURS as unknown,
  openingHours = {} as unknown,
  appointments = [] as Array<{
    professionalId: string;
    scheduledTime: string;
    duration: number;
    status?: string;
  }>,
} = {}) {
  const prisma: any = {
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ id: TENANT_ID, openingHours }),
    },
    professional: {
      // Answers both lookups: the named-professional one and the
      // any-professional one that check_availability triggers.
      findMany: jest
        .fn()
        .mockResolvedValue([{ id: PRO_ID, tenantId: TENANT_ID, workingHours, isActive: true }]),
    },
    service: {
      findFirst: jest
        .fn()
        .mockResolvedValue({ id: SERVICE_ID, tenantId: TENANT_ID, duration: 30 }),
    },
    appointment: {
      findMany: jest.fn().mockResolvedValue(
        appointments.map((a, i) => ({
          id: `apt-${i}`,
          status: a.status ?? "confirmed",
          ...a,
        })),
      ),
    },
  };
  // getAvailableSlots touches only prisma. The other eight collaborators are
  // stubbed because the constructor requires them, not because they are used.
  const stub = {} as any;
  const service = new AppointmentsService(
    prisma,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
  );
  return { service, prisma };
}

async function times(
  date: string,
  opts?: Parameters<typeof build>[0],
): Promise<string[]> {
  const { service } = build(opts);
  const slots = await service.getAvailableSlots(
    TENANT_ID,
    new Date(`${date}T00:00:00.000Z`),
    PRO_ID,
    SERVICE_ID,
    30,
  );
  return slots.map((s: { time: string }) => s.time);
}

describe("getAvailableSlots respects the professional's shift", () => {
  it("offers nothing on a day she does not work", async () => {
    // 2026-09-27 is a Sunday. The old page offered 09:00 to 19:30 anyway.
    expect(await times("2026-09-27")).toEqual([]);
  });

  it("stops at her closing time, not at the fallback 20:00", async () => {
    // Monday: 09:00–18:00. A 30-minute service can start at 17:30 at the
    // latest. 18:00, 19:00 and 19:30 were all offered before.
    const slots = await times("2026-09-28");

    expect(slots[0]).toBe("09:00");
    expect(slots[slots.length - 1]).toBe("17:30");
    expect(slots).not.toContain("18:00");
    expect(slots).not.toContain("19:30");
  });

  it("uses each weekday's own hours", async () => {
    // Tuesday closes an hour later than Monday.
    const monday = await times("2026-09-28");
    const tuesday = await times("2026-09-29");

    expect(monday[monday.length - 1]).toBe("17:30");
    expect(tuesday[tuesday.length - 1]).toBe("18:30");
  });

  it("removes a slot that clashes with an existing appointment", async () => {
    const slots = await times("2026-09-28", {
      appointments: [
        { professionalId: PRO_ID, scheduledTime: "10:00", duration: 30 },
      ],
    });

    expect(slots).not.toContain("10:00");
    expect(slots).toContain("09:30");
    expect(slots).toContain("10:30");
  });

  it("removes every slot a longer appointment covers", async () => {
    // A 90-minute colour at 11:00 blocks 11:00, 11:30 and 12:00.
    const slots = await times("2026-09-28", {
      appointments: [
        { professionalId: PRO_ID, scheduledTime: "11:00", duration: 90 },
      ],
    });

    for (const blocked of ["11:00", "11:30", "12:00"]) {
      expect(slots).not.toContain(blocked);
    }
    expect(slots).toContain("10:30");
    expect(slots).toContain("12:30");
  });

  it("keeps a cancelled appointment's slot bookable", async () => {
    // The query filters cancelled out; this guards that it stays that way.
    const { service, prisma } = build();
    await service.getAvailableSlots(
      TENANT_ID,
      new Date("2026-09-28T00:00:00.000Z"),
      PRO_ID,
      SERVICE_ID,
      30,
    );

    expect(prisma.appointment.findMany.mock.calls[0][0].where.status).toEqual({
      not: "cancelled",
    });
  });

  it("stays fully bookable for a professional with no schedule recorded", async () => {
    // Every salon that existed before this change has workingHours: []. They
    // must not go dark.
    const slots = await times("2026-09-27", { workingHours: [] });

    expect(slots.length).toBeGreaterThan(0);
    expect(slots[0]).toBe("09:00");
  });

  it("still honours the tenant's openingHours when it has them", async () => {
    const slots = await times("2026-09-28", {
      workingHours: [],
      openingHours: { open: "10:00", close: "14:00" },
    });

    expect(slots[0]).toBe("10:00");
    expect(slots).not.toContain("09:30");
    expect(slots[slots.length - 1]).toBe("13:30");
  });
});

/**
 * "Any professional" — the shape the virtual receptionist asks for.
 *
 * The first version of the shift check only ran when a professional was named,
 * which is what the public booking page always does. The receptionist's
 * `check_availability` tool does not name one, so it fell through to a window
 * of 09:00–20:00.
 *
 * Caught by talking to the receptionist in production: asked for a Tuesday
 * afternoon, it came back with 22 slots ending at 19:30 on a salon whose only
 * professional leaves at 19:00 — while the same day through the named-
 * professional path correctly returned 20, ending at 18:30.
 */
describe("getAvailableSlots with no professional named", () => {
  async function anyPro(
    date: string,
    opts?: Parameters<typeof build>[0],
  ): Promise<string[]> {
    const { service } = build(opts);
    const slots = await service.getAvailableSlots(
      TENANT_ID,
      new Date(`${date}T00:00:00.000Z`),
      undefined,
      SERVICE_ID,
      30,
    );
    return slots.map((s: { time: string }) => s.time);
  }

  it("still respects the only professional's shift", async () => {
    // The bug: this returned up to 19:30.
    const slots = await anyPro("2026-09-29");

    expect(slots[slots.length - 1]).toBe("18:30");
    expect(slots).not.toContain("19:00");
    expect(slots).not.toContain("19:30");
  });

  it("offers nothing when nobody works that day", async () => {
    expect(await anyPro("2026-09-27")).toEqual([]);
  });

  it("uses each weekday's hours, as the named path does", async () => {
    const monday = await anyPro("2026-09-28");

    expect(monday[monday.length - 1]).toBe("17:30");
  });

  it("agrees with the named-professional path", async () => {
    // The two must never disagree: the receptionist and the booking page have
    // to offer the same hours, or one of them is lying to a client.
    for (const date of ["2026-09-28", "2026-09-29", "2026-09-27"]) {
      expect(await anyPro(date)).toEqual(await times(date));
    }
  });

  it("imposes no shift limit when the salon has no professionals at all", async () => {
    const { service } = build();
    // Override: the tenant has nobody on the books.
    (service as any).prisma.professional.findMany = jest.fn().mockResolvedValue([]);

    const slots = await service.getAvailableSlots(
      TENANT_ID,
      new Date("2026-09-27T00:00:00.000Z"),
      undefined,
      SERVICE_ID,
      30,
    );

    expect(slots.length).toBeGreaterThan(0);
  });
});
