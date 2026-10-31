import { AppointmentsService } from "./appointments.service";

/**
 * Availability with time off and salon closures (time-off-rules.ts), and the
 * candidate slot grid.
 *
 * A professional's vacation or an afternoon at the doctor, and a salon closed
 * for Christmas, existed nowhere: online booking and the receptionist offered
 * those days like any other. Now a closure day has no slots, an all-day
 * absence takes that professional out, and a partial one takes its minutes
 * out of their shifts -- in both the named and the "any professional" path.
 *
 * The grid was the salon's opening hours or 09:00–20:00 alone: a shift until
 * 22:00 offered nothing after 19:30, and one starting at 10:15 never offered
 * 10:15.
 */

const TENANT_ID = "tenant-1";
const OTHER_TENANT = "tenant-2";
const ANA = "pro-ana";
const BEA = "pro-bea";
const SERVICE_ID = "svc-cut";
const MONDAY = "2026-11-02";

const MON_10_TO_14 = [{ day: "monday", openTime: "10:00", closeTime: "14:00" }];

interface Row {
  tenantId?: string;
  professionalId: string | null;
  kind: string;
  startDate: string;
  endDate: string;
  startTime?: string | null;
  endTime?: string | null;
  note?: string | null;
  status?: string;
}

function build(opts: {
  professionals: Array<{ id: string; workingHours?: unknown }>;
  timeOff?: Row[];
  openingHours?: { open?: string; close?: string };
  duration?: number;
}) {
  const timeOff = (opts.timeOff ?? []).map((r) => ({
    tenantId: TENANT_ID,
    startTime: null,
    endTime: null,
    note: null,
    ...r,
    startDate: new Date(`${r.startDate}T00:00:00.000Z`),
    endDate: new Date(`${r.endDate}T00:00:00.000Z`),
  }));
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
    // Honours the query the way the database would, tenant included: a row
    // of another salon must never come back.
    timeOff: {
      findMany: jest.fn(async ({ where }: any) =>
        timeOff.filter(
          (r) => r.tenantId === where.tenantId && r.startDate <= where.startDate.lte && r.endDate >= where.endDate.gte,
        ),
      ),
    },
  };
  const stub = {} as any;
  return { svc: new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub), prisma };
}

const times = (slots: Array<{ time: string }>) => slots.map((s) => s.time);

async function named(opts: Parameters<typeof build>[0], professionalId = ANA): Promise<string[]> {
  const { svc } = build(opts);
  return times(await svc.getAvailableSlots(TENANT_ID, new Date(`${MONDAY}T00:00:00.000Z`), professionalId, SERVICE_ID));
}

async function anyone(opts: Parameters<typeof build>[0]): Promise<string[]> {
  const { svc } = build(opts);
  return times(await svc.getAvailableSlots(TENANT_ID, new Date(`${MONDAY}T00:00:00.000Z`), undefined, SERVICE_ID));
}

const closure = (extra: Partial<Row> = {}): Row => ({
  professionalId: null,
  kind: "closure",
  startDate: MONDAY,
  endDate: MONDAY,
  note: "Fiesta local",
  ...extra,
});

describe("availability on a salon closure", () => {
  it("offers nothing for a named professional", async () => {
    expect(await named({ professionals: [{ id: ANA, workingHours: MON_10_TO_14 }], timeOff: [closure()] })).toEqual([]);
  });

  it("offers nothing for any professional, scheduled or not", async () => {
    expect(
      await anyone({
        professionals: [{ id: ANA, workingHours: MON_10_TO_14 }, { id: BEA }],
        timeOff: [closure()],
      }),
    ).toEqual([]);
  });

  it("offers nothing when the salon has no professionals recorded", async () => {
    expect(await anyone({ professionals: [], timeOff: [closure()] })).toEqual([]);
  });

  it("covers every day of a range, and only those", async () => {
    const week = closure({ startDate: "2026-10-30", endDate: MONDAY });
    expect(await named({ professionals: [{ id: ANA }], timeOff: [week] })).toEqual([]);
    const after = closure({ startDate: "2026-11-03", endDate: "2026-11-05" });
    expect(await named({ professionals: [{ id: ANA }], timeOff: [after] })).not.toEqual([]);
  });

  it("a partial closure takes its hours from everyone", async () => {
    const afternoon = closure({ startTime: "12:00", endTime: "20:00" });
    expect(await named({ professionals: [{ id: ANA, workingHours: MON_10_TO_14 }], timeOff: [afternoon] })).toEqual([
      "10:00",
      "10:30",
      "11:00",
    ]);
    const salon = await anyone({ professionals: [], timeOff: [afternoon] });
    expect(salon).toContain("11:00");
    expect(salon).not.toContain("11:30");
    expect(salon).not.toContain("15:00");
  });
});

describe("availability with a professional's time off", () => {
  const vacation: Row = { professionalId: ANA, kind: "vacation", startDate: "2026-10-26", endDate: "2026-11-06" };

  it("an all-day absence leaves the named professional with nothing", async () => {
    expect(await named({ professionals: [{ id: ANA, workingHours: MON_10_TO_14 }], timeOff: [vacation] })).toEqual([]);
  });

  it("even when no schedule is recorded for them", async () => {
    expect(await named({ professionals: [{ id: ANA }], timeOff: [vacation] })).toEqual([]);
  });

  it("a request still pending, or rejected, takes nothing out of the day", async () => {
    // The mock answers whatever matches the dates: the rules ignore it all the same.
    for (const status of ["pending", "rejected"]) {
      expect(
        await named({ professionals: [{ id: ANA, workingHours: MON_10_TO_14 }], timeOff: [{ ...vacation, status }] }),
      ).toEqual(await named({ professionals: [{ id: ANA, workingHours: MON_10_TO_14 }] }));
    }
    expect(await named({ professionals: [{ id: ANA, workingHours: MON_10_TO_14 }] })).not.toEqual([]);
    const { svc, prisma } = build({ professionals: [{ id: ANA }] });
    await svc.getAvailableSlots(TENANT_ID, new Date(`${MONDAY}T00:00:00.000Z`), ANA, SERVICE_ID);
    expect(prisma.timeOff.findMany.mock.calls[0][0].where.status).toBe("approved");
  });

  it("once approved, it does", async () => {
    expect(
      await named({ professionals: [{ id: ANA, workingHours: MON_10_TO_14 }], timeOff: [{ ...vacation, status: "approved" }] }),
    ).toEqual([]);
  });

  it("any professional: a colleague still covers the day", async () => {
    const slots = await anyone({
      professionals: [{ id: ANA, workingHours: MON_10_TO_14 }, { id: BEA, workingHours: [{ day: "monday", openTime: "16:00", closeTime: "18:00" }] }],
      timeOff: [vacation],
    });
    expect(slots).toEqual(["16:00", "16:30", "17:00"]);
  });

  it("any professional: nobody left when the only one is away", async () => {
    expect(await anyone({ professionals: [{ id: ANA, workingHours: MON_10_TO_14 }], timeOff: [vacation] })).toEqual([]);
  });

  it("a partial absence is cut out of the shift: no service runs into it", async () => {
    const doctor: Row = { professionalId: ANA, kind: "other", startDate: MONDAY, endDate: MONDAY, startTime: "11:30", endTime: "12:30" };
    expect(await named({ professionals: [{ id: ANA, workingHours: MON_10_TO_14 }], timeOff: [doctor] })).toEqual([
      "10:00",
      "10:30",
      "12:30",
      "13:00",
    ]);
    expect(await anyone({ professionals: [{ id: ANA, workingHours: MON_10_TO_14 }], timeOff: [doctor] })).toEqual([
      "10:00",
      "10:30",
      "12:30",
      "13:00",
    ]);
  });

  it("with no schedule recorded, a partial absence still blocks its minutes", async () => {
    const doctor: Row = { professionalId: ANA, kind: "other", startDate: MONDAY, endDate: MONDAY, startTime: "10:00", endTime: "11:15" };
    const slots = await named({ professionals: [{ id: ANA }], timeOff: [doctor] });
    expect(slots).toContain("09:00");
    expect(slots).not.toContain("09:30"); // would run into 10:00
    expect(slots).not.toContain("10:30");
    // The end of the block starts a slot.
    expect(slots).toContain("11:15");
    expect(slots).toContain("11:30");
    expect(slots).toContain("19:00");
  });

  it("a colleague's absence changes nothing for Ana", async () => {
    const beaAway: Row = { ...vacation, professionalId: BEA };
    expect(await named({ professionals: [{ id: ANA, workingHours: MON_10_TO_14 }], timeOff: [beaAway] })).toEqual(
      await named({ professionals: [{ id: ANA, workingHours: MON_10_TO_14 }] }),
    );
  });
});

describe("another salon's time off", () => {
  it("never blocks this salon, named or any", async () => {
    const foreign: Row[] = [
      { ...closure(), tenantId: OTHER_TENANT },
      { tenantId: OTHER_TENANT, professionalId: ANA, kind: "vacation", startDate: MONDAY, endDate: MONDAY },
    ];
    const pros = [{ id: ANA, workingHours: MON_10_TO_14 }];
    expect(await named({ professionals: pros, timeOff: foreign })).toEqual(await named({ professionals: pros }));
    expect(await anyone({ professionals: pros, timeOff: foreign })).toEqual(await anyone({ professionals: pros }));
  });

  it("is asked for by this salon's id only", async () => {
    const { svc, prisma } = build({ professionals: [{ id: ANA }] });
    await svc.getAvailableSlots(TENANT_ID, new Date(`${MONDAY}T00:00:00.000Z`), ANA, SERVICE_ID);
    expect(prisma.timeOff.findMany.mock.calls[0][0].where.tenantId).toBe(TENANT_ID);
  });
});

describe("the candidate slot grid", () => {
  it("reaches a shift past 20:00", async () => {
    const late = [{ day: "monday", openTime: "16:00", closeTime: "22:00" }];
    const slots = await named({ professionals: [{ id: ANA, workingHours: late }] });
    expect(slots[slots.length - 1]).toBe("21:00");
    expect(slots).toContain("20:30");
    const anySlots = await anyone({ professionals: [{ id: ANA, workingHours: late }] });
    expect(anySlots).toEqual(slots);
  });

  it("reaches a shift before the salon's configured opening", async () => {
    const early = [{ day: "monday", openTime: "07:00", closeTime: "12:00" }];
    const slots = await named({ professionals: [{ id: ANA, workingHours: early }], openingHours: { open: "09:00", close: "20:00" } });
    expect(slots[0]).toBe("07:00");
  });

  it("offers the start of a shift off the half hour, then the half hours", async () => {
    const quarter = [{ day: "monday", openTime: "10:15", closeTime: "12:00" }];
    expect(await named({ professionals: [{ id: ANA, workingHours: quarter }], duration: 30 })).toEqual([
      "10:15",
      "10:30",
      "11:00",
      "11:30",
    ]);
  });

  it("without schedules, keeps the 09:00–20:00 half hours", async () => {
    const slots = await anyone({ professionals: [{ id: ANA }], duration: 30 });
    expect(slots[0]).toBe("09:00");
    expect(slots[slots.length - 1]).toBe("19:30");
    expect(slots).toHaveLength(22);
  });
});
