import { BadRequestException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { HOME_LIST_SIZE, HomeSummaryService, inLocation, salonNow } from "./home-summary.service";

/**
 * GET /appointments/home (Inicio). The page kept the first five of every
 * "pending" appointment of a year back and ahead, oldest first: old visits
 * never closed, counters stuck at 5, today's confirmed appointments missing
 * from "today's schedule" and next week's pending ones in it.
 */

const TENANT = "tenant-a";
const OWNER = { id: "u-owner", role: "owner", tenantId: TENANT };
const STAFF = { id: "u-ana", role: "staff", tenantId: TENANT };
// 23:30 UTC on 3 Nov is already 4 Nov in Madrid (UTC+1).
const LATE_EVENING_UTC = new Date("2026-11-03T23:30:00.000Z");

const LOC_CENTRO = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LOC_TRIANA = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const SCOPE_CENTRO = { locationId: LOC_CENTRO, name: "Centro", professionalIds: ["p-ana"] };
const OCCUPANCY = { bookedMinutes: 120, availableMinutes: 480, rate: 25, professionalsWithSchedule: 1 };

const person = (id: string) => ({ id, firstName: id, lastName: "X", email: "x@example.test" });

function apt(id: string, day: string, time: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    scheduledDate: new Date(`${day}T00:00:00.000Z`),
    scheduledTime: time,
    status,
    paymentStatus: "pending",
    client: person(`c-${id}`),
    professional: person("p-ana"),
    service: { id: "s1", name: "Corte", price: 20 },
    tenant: { id: TENANT, stripeSecretKey: "never" },
    ...extra,
  };
}

function build({
  todays = [] as any[],
  pendingCount = 0,
  pendingRows = [] as any[],
  owed = [] as any[],
  professional = { id: "p-ana" } as { id: string } | null,
  team = [] as any[],
  empresa = true,
} = {}) {
  const calls: Record<string, any[]> = {
    count: [],
    findMany: [],
    findAll: [],
    findPendingPayment: [],
    team: [],
    occupancy: [],
  };
  const prisma: any = {
    tenant: { findUnique: async () => ({ timezone: "Europe/Madrid" }) },
    professional: {
      findFirst: async () => professional,
      findMany: async (args: any) => {
        calls.team.push(args);
        return team;
      },
    },
    appointment: {
      count: async (args: any) => {
        calls.count.push(args);
        return pendingCount;
      },
      findMany: async (args: any) => {
        calls.findMany.push(args);
        return pendingRows.slice(0, args.take);
      },
    },
  };
  const appointments: any = {
    findAll: async (user: any, filters: any) => {
      calls.findAll.push({ user, filters });
      return todays;
    },
    findPendingPayment: async (user: any, filters: any) => {
      calls.findPendingPayment.push({ user, filters });
      return owed;
    },
  };
  const analytics: any = {
    locationScope: async (_t: string, id: string) => {
      if (id !== LOC_CENTRO) throw new NotFoundException("Local no encontrado");
      return SCOPE_CENTRO;
    },
    getTodayOccupancy: async (tenantId: string, scope: unknown) => {
      calls.occupancy.push({ tenantId, scope });
      return OCCUPANCY;
    },
  };
  const flags: any = { hasLocationFilter: async () => empresa };
  return { service: new HomeSummaryService(prisma, appointments, analytics, flags), calls };
}

describe("salonNow", () => {
  it("is the salon's day and clock, not UTC's", () => {
    expect(salonNow("Europe/Madrid", LATE_EVENING_UTC)).toEqual({ day: "2026-11-04", time: "00:30" });
    expect(salonNow("Atlantic/Canary", LATE_EVENING_UTC)).toEqual({ day: "2026-11-03", time: "23:30" });
  });

  it("falls back to Madrid for an unknown zone", () => {
    expect(salonNow("Not/AZone", LATE_EVENING_UTC)).toEqual({ day: "2026-11-04", time: "00:30" });
  });
});

describe("HomeSummaryService.getHome", () => {
  it("today: the salon day's pending, confirmed and in-progress appointments, by time", async () => {
    const { service, calls } = build({
      todays: [
        apt("late", "2026-11-04", "18:00", "confirmed"),
        apt("done", "2026-11-04", "09:00", "completed"),
        apt("cancelled", "2026-11-04", "10:00", "cancelled"),
        apt("early", "2026-11-04", "9:30", "pending"),
        apt("now", "2026-11-04", "11:00", "in_progress"),
      ],
    });
    const home = await service.getHome(OWNER, {}, LATE_EVENING_UTC);

    expect(home.today).toBe("2026-11-04");
    expect(home.now).toBe("00:30");
    expect(home.todayAppointments.map((a) => a.id)).toEqual(["early", "now", "late"]);
    // Asked for one salon day only.
    const { filters } = calls.findAll[0];
    expect(filters.startDate.toISOString()).toBe("2026-11-04T00:00:00.000Z");
    expect(filters.endDate.toISOString()).toBe("2026-11-04T23:59:59.999Z");
  });

  it("today leaves out the onboarding wizard's test booking (D27)", async () => {
    const { service } = build({
      todays: [
        apt("real", "2026-11-04", "10:00", "confirmed"),
        { ...apt("test", "2026-11-04", "11:00", "confirmed"), isTest: true },
      ],
    });
    const home = await service.getHome(OWNER, {}, LATE_EVENING_UTC);
    expect(home.todayAppointments.map((a) => a.id)).toEqual(["real"]);
  });

  it("rows carry what the page shows, not the salon record", async () => {
    const { service } = build({ todays: [apt("a", "2026-11-04", "10:00", "confirmed")] });
    const [row] = (await service.getHome(OWNER, {}, LATE_EVENING_UTC)).todayAppointments;
    expect(row).toEqual({
      id: "a",
      scheduledDate: "2026-11-04",
      scheduledTime: "10:00",
      status: "confirmed",
      paymentStatus: "pending",
      client: { id: "c-a", firstName: "c-a", lastName: "X" },
      professional: { id: "p-ana", firstName: "p-ana", lastName: "X" },
      service: { id: "s1", name: "Corte" },
    });
    expect(JSON.stringify(row)).not.toContain("never");
  });

  it("to confirm: pending from the salon's today on, soonest first, five rows and the server's count", async () => {
    const rows = Array.from({ length: 8 }, (_, i) => apt(`p${i}`, "2026-11-05", `1${i}:00`, "pending"));
    const { service, calls } = build({ pendingCount: 23, pendingRows: rows });
    const home = await service.getHome(OWNER, {}, LATE_EVENING_UTC);

    expect(home.pendingConfirmations.total).toBe(23);
    expect(home.pendingConfirmations.items).toHaveLength(HOME_LIST_SIZE);
    expect(home.pendingConfirmations.items[0].id).toBe("p0");
    const [query] = calls.findMany;
    expect(query.where).toEqual({
      tenantId: TENANT,
      isTest: false,
      status: "pending",
      scheduledDate: { gte: new Date("2026-11-04T00:00:00.000Z") },
    });
    expect(query.orderBy).toEqual([{ scheduledDate: "asc" }, { scheduledTime: "asc" }]);
    expect(query.take).toBe(HOME_LIST_SIZE);
    expect(calls.count[0].where).toEqual(query.where);
  });

  it("to charge: every owed visit counted and added up, the five latest shown", async () => {
    const owed = Array.from({ length: 7 }, (_, i) =>
      apt(`o${i}`, `2026-10-2${i}`, "10:00", "completed", { amountDue: 1000 * (i + 1) }),
    );
    const { service, calls } = build({ owed });
    const home = await service.getHome(OWNER, {}, LATE_EVENING_UTC);

    expect(home.pendingPayments.total).toBe(7);
    expect(home.pendingPayments.totalDue).toBe(28000);
    expect(home.pendingPayments.items.map((r) => r.id)).toEqual(["o6", "o5", "o4", "o3", "o2"]);
    expect(home.pendingPayments.items[0].amountDue).toBe(7000);
    // Up to the end of the salon's day, not the UTC one.
    expect(calls.findPendingPayment[0].filters).toEqual({ dateTo: "2026-11-04T23:59:59.999Z" });
  });

  it("staff: the count is of their own agenda, the colleagues' visits where they do a service included", async () => {
    const { service, calls } = build({ pendingCount: 2 });
    await service.getHome(STAFF, {}, LATE_EVENING_UTC);
    const agenda = [{ professionalId: "p-ana" }, { services: { some: { professionalId: "p-ana" } } }];
    expect(calls.count[0].where.OR).toEqual(agenda);
    expect(calls.findMany[0].where.OR).toEqual(agenda);
    expect(calls.findMany[0].where.professionalId).toBeUndefined();
    expect(calls.findAll[0].user).toBe(STAFF);
    expect(calls.findPendingPayment[0].user).toBe(STAFF);
  });

  it("staff with no professional: nothing at all", async () => {
    const { service, calls } = build({ professional: null, pendingCount: 9 });
    const home = await service.getHome(STAFF, {}, LATE_EVENING_UTC);
    expect(home.pendingConfirmations).toEqual({ total: 0, items: [] });
    expect(home.pendingPayments).toEqual({ total: 0, totalDue: 0, items: [] });
    expect(home.todayAppointments).toEqual([]);
    expect(calls.count).toHaveLength(0);
  });

  it("the team for the agenda by professional: active ones by name; staff only themselves", async () => {
    const { service, calls } = build({
      team: [
        { id: "p2", firstName: "Lucía", lastName: "Ruiz" },
        { id: "p1", firstName: "Ana", lastName: "Gil" },
      ],
    });
    const home = await service.getHome(OWNER, {}, LATE_EVENING_UTC);
    expect(home.professionals.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(calls.team[0].where).toEqual({ tenantId: TENANT, isActive: true });

    const staff = build();
    await staff.service.getHome(STAFF, {}, LATE_EVENING_UTC);
    expect(staff.calls.team[0].where).toEqual({ tenantId: TENANT, id: "p-ana" });
  });

  it("today's occupancy for owner and admins (Analítica's), none for staff", async () => {
    const owner = build();
    expect((await owner.service.getHome(OWNER, {}, LATE_EVENING_UTC)).occupancy).toEqual(OCCUPANCY);
    expect(owner.calls.occupancy[0]).toEqual({ tenantId: TENANT, scope: undefined });

    const staff = build();
    expect((await staff.service.getHome(STAFF, {}, LATE_EVENING_UTC)).occupancy).toBeNull();
    expect(staff.calls.occupancy).toHaveLength(0);
  });
});

describe("HomeSummaryService.getHome by location (Empresa, D24)", () => {
  it("cuts every list to the location, with Analítica's rule", async () => {
    const { service, calls } = build({
      todays: [
        apt("here", "2026-11-04", "10:00", "confirmed", { locationId: LOC_CENTRO, professionalId: "p-bea" }),
        apt("there", "2026-11-04", "11:00", "confirmed", { locationId: LOC_TRIANA, professionalId: "p-ana" }),
        apt("legacy", "2026-11-04", "12:00", "pending", { locationId: null, professionalId: "p-ana" }),
        apt("legacy-other", "2026-11-04", "13:00", "pending", { locationId: null, professionalId: "p-bea" }),
      ],
      owed: [
        apt("owed-here", "2026-11-01", "10:00", "completed", { locationId: LOC_CENTRO, amountDue: 1500 }),
        apt("owed-there", "2026-11-01", "11:00", "completed", { locationId: LOC_TRIANA, amountDue: 9000 }),
      ],
    });
    const home = await service.getHome(OWNER, { locationId: LOC_CENTRO }, LATE_EVENING_UTC);

    expect(home.location).toEqual({ id: LOC_CENTRO, name: "Centro" });
    expect(home.todayAppointments.map((a) => a.id)).toEqual(["here", "legacy"]);
    expect(home.pendingPayments).toMatchObject({ total: 1, totalDue: 1500 });
    expect(calls.count[0].where.OR).toEqual([
      { locationId: LOC_CENTRO },
      { locationId: null, professionalId: { in: ["p-ana"] } },
    ]);
    expect(calls.team[0].where).toEqual({ tenantId: TENANT, isActive: true, id: { in: ["p-ana"] } });
    expect(calls.occupancy[0].scope).toBe(SCOPE_CENTRO);
  });

  it("refuses what Analítica refuses", async () => {
    await expect(build().service.getHome(OWNER, { locationId: "centro" })).rejects.toBeInstanceOf(BadRequestException);
    await expect(build({ empresa: false }).service.getHome(OWNER, { locationId: LOC_CENTRO })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    await expect(build().service.getHome(OWNER, { locationId: LOC_TRIANA })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("staff: ignored, they already see only their own", async () => {
    const { service, calls } = build();
    const home = await service.getHome(STAFF, { locationId: LOC_TRIANA }, LATE_EVENING_UTC);
    expect(home.location).toBeNull();
    // Their agenda only (staffAgendaWhere), no location filter.
    expect(calls.count[0].where.OR).toEqual([
      { professionalId: "p-ana" },
      { services: { some: { professionalId: "p-ana" } } },
    ]);
    expect(JSON.stringify(calls.count[0].where)).not.toContain("locationId");
  });

  it("inLocation: booked there, or with no location by one of its professionals", () => {
    expect(inLocation({ locationId: LOC_CENTRO, professionalId: "x" }, SCOPE_CENTRO)).toBe(true);
    expect(inLocation({ locationId: LOC_TRIANA, professionalId: "p-ana" }, SCOPE_CENTRO)).toBe(false);
    expect(inLocation({ locationId: null, professionalId: "p-ana" }, SCOPE_CENTRO)).toBe(true);
    expect(inLocation({ locationId: null, professionalId: null }, SCOPE_CENTRO)).toBe(false);
    expect(inLocation({ locationId: LOC_TRIANA }, undefined)).toBe(true);
  });
});
