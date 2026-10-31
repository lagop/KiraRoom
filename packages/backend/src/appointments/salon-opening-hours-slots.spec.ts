import { AppointmentsService } from "./appointments.service";

/**
 * Availability with the salon's own opening hours (Tenant.openingHours, per
 * weekday with shifts) on top of each professional's schedule.
 *
 * A professional is bookable only where their shifts and the salon's hours
 * meet when both are recorded; with only one recorded, that one decides; with
 * neither, nothing changes. A weekday the salon has no hours is closed, even
 * for a professional with a shift that day.
 */

const TENANT_ID = "tenant-1";
const ANA = "pro-ana";
const BEA = "pro-bea";
const SERVICE_ID = "svc-cut";
const MONDAY = "2026-11-02";
const SUNDAY = "2026-11-08";

/** Mon–Fri 10–14 and 17–20, Sat 10–14, Sun closed. */
const SALON_WEEK = [
  ...["monday", "tuesday", "wednesday", "thursday", "friday"].flatMap((day) => [
    { day, openTime: "10:00", closeTime: "14:00" },
    { day, openTime: "17:00", closeTime: "20:00" },
  ]),
  { day: "saturday", openTime: "10:00", closeTime: "14:00" },
];

const EVERY_DAY_9_TO_19 = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"].map((day) => ({
  day,
  openTime: "09:00",
  closeTime: "19:00",
}));

function build(opts: {
  professionals: Array<{ id: string; workingHours?: unknown }>;
  openingHours?: unknown;
  duration?: number;
}) {
  const prisma: any = {
    tenant: {
      findUnique: jest.fn(async () => ({
        id: TENANT_ID,
        openingHours: opts.openingHours ?? {},
        timezone: "Europe/Madrid",
      })),
    },
    professional: {
      findMany: jest.fn(async () =>
        opts.professionals.map((p) => ({ tenantId: TENANT_ID, isActive: true, workingHours: null, services: [], ...p })),
      ),
    },
    service: {
      findFirst: jest.fn(async () => ({ id: SERVICE_ID, tenantId: TENANT_ID, duration: opts.duration ?? 60, isActive: true })),
    },
    appointment: { findMany: jest.fn(async () => []) },
    timeOff: { findMany: jest.fn(async () => []) },
  };
  const stub = {} as any;
  return new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
}

const times = (slots: Array<{ time: string }>) => slots.map((s) => s.time);

async function named(opts: Parameters<typeof build>[0], day = MONDAY): Promise<string[]> {
  return times(await build(opts).getAvailableSlots(TENANT_ID, new Date(`${day}T00:00:00.000Z`), ANA, SERVICE_ID));
}

async function anyone(opts: Parameters<typeof build>[0], day = MONDAY): Promise<string[]> {
  return times(await build(opts).getAvailableSlots(TENANT_ID, new Date(`${day}T00:00:00.000Z`), undefined, SERVICE_ID));
}

describe("a professional inside the salon's hours", () => {
  const opts = { professionals: [{ id: ANA, workingHours: EVERY_DAY_9_TO_19 }], openingHours: SALON_WEEK };

  it("salon 10–14 and 17–20, professional 09–19: 13:00 for an hour yes, 14:00 no, 17:00 yes", async () => {
    const slots = await named(opts);
    expect(slots).toContain("13:00");
    expect(slots).not.toContain("14:00");
    expect(slots).not.toContain("13:30"); // would run into the salon's lunch
    expect(slots).toContain("17:00");
    // The professional leaves at 19:00: 18:00 is the last hour that fits both.
    expect(slots).toContain("18:00");
    expect(slots).not.toContain("18:30");
    // Before the salon opens, though the professional is in.
    expect(slots).not.toContain("09:00");
    expect(slots[0]).toBe("10:00");
  });

  it("the same for any professional", async () => {
    expect(await anyone(opts)).toEqual(await named(opts));
  });

  it("a weekday without salon hours is closed, whoever has a shift", async () => {
    expect(await named(opts, SUNDAY)).toEqual([]);
    expect(await anyone(opts, SUNDAY)).toEqual([]);
  });
});

describe("only one of the two recorded", () => {
  it("only the salon's hours: they bound a professional with no schedule", async () => {
    const slots = await named({ professionals: [{ id: ANA }], openingHours: SALON_WEEK });
    expect(slots).toEqual(["10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "17:00", "17:30", "18:00", "18:30", "19:00"]);
  });

  it("only the salon's hours, and no professionals at all", async () => {
    const slots = await anyone({ professionals: [], openingHours: SALON_WEEK });
    expect(slots[0]).toBe("10:00");
    expect(slots).not.toContain("14:00");
    expect(slots[slots.length - 1]).toBe("19:00");
    expect(await anyone({ professionals: [], openingHours: SALON_WEEK }, SUNDAY)).toEqual([]);
  });

  it("only the professional's: no salon-level limit, as before", async () => {
    for (const openingHours of [{}, [], null, { mon: { open: "10:00", close: "12:00" } }]) {
      const slots = await named({ professionals: [{ id: ANA, workingHours: EVERY_DAY_9_TO_19 }], openingHours });
      expect(slots[0]).toBe("09:00");
      expect(slots[slots.length - 1]).toBe("18:00");
    }
  });

  it("neither: the 09:00–20:00 grid, unchanged", async () => {
    const slots = await anyone({ professionals: [{ id: ANA }], duration: 30 });
    expect(slots[0]).toBe("09:00");
    expect(slots[slots.length - 1]).toBe("19:30");
  });
});

describe("any professional across the salon's hours", () => {
  it("a slot is offered when someone is in for it inside the salon's hours", async () => {
    // Ana mornings, Bea afternoons until 21:00; the salon closes at 20:00.
    const ana = [{ day: "monday", openTime: "09:00", closeTime: "14:00" }];
    const bea = [{ day: "monday", openTime: "16:00", closeTime: "21:00" }];
    const slots = await anyone({
      professionals: [
        { id: ANA, workingHours: ana },
        { id: BEA, workingHours: bea },
      ],
      openingHours: SALON_WEEK,
    });
    expect(slots).toEqual(["10:00", "10:30", "11:00", "11:30", "12:00", "12:30", "13:00", "17:00", "17:30", "18:00", "18:30", "19:00"]);
  });
});

describe("the legacy { open, close }", () => {
  it("is the salon's hours every day", async () => {
    const opts = { professionals: [{ id: ANA, workingHours: EVERY_DAY_9_TO_19 }], openingHours: { open: "10:00", close: "16:00" } };
    const slots = await named(opts);
    expect(slots[0]).toBe("10:00");
    expect(slots[slots.length - 1]).toBe("15:00");
    expect((await named(opts, SUNDAY))[0]).toBe("10:00");
  });

  it("an unreadable pair is no limit", async () => {
    const slots = await named({ professionals: [{ id: ANA, workingHours: EVERY_DAY_9_TO_19 }], openingHours: { open: "20:00", close: "09:00" } });
    expect(slots[0]).toBe("09:00");
  });
});
