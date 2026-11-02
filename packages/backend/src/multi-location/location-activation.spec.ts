/**
 * Reactivating locations (A6). The edit form had no "Activo" control, the
 * plan limit counted inactive locations too, and deactivating said nothing
 * about the appointments still booked there: a salon at its limit that
 * closed a location by mistake could neither bring it back nor create a new
 * one. Only active locations count now, PATCH { isActive: true } reactivates
 * within the limit, and the panel can ask how many appointments are coming
 * up before it deactivates one.
 */
import { BadRequestException } from "@nestjs/common";
import { MultiLocationService } from "./multi-location.service";

function makeService(opts: {
  location?: Record<string, unknown>;
  activeCount?: number;
  maxLocations?: number;
  appointments?: Array<{ locationId: string | null; professionalId: string | null }>;
  links?: Array<{ professionalId: string; locationId: string; isPrimary: boolean }>;
  activeIds?: string[];
} = {}) {
  const prisma = {
    location: {
      findFirst: jest.fn().mockResolvedValue({ id: "loc-1", name: "Centro", isActive: true, ...opts.location }),
      findUnique: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(opts.activeCount ?? 1),
      create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "new", ...data })),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "loc-1", ...data })),
      findMany: jest.fn().mockResolvedValue((opts.activeIds ?? ["loc-2"]).map((id) => ({ id }))),
    },
    tenant: {
      findUnique: jest.fn().mockResolvedValue({ maxLocations: opts.maxLocations ?? 2, plan: "empresa", timezone: "Europe/Madrid" }),
    },
    appointment: { findMany: jest.fn().mockResolvedValue(opts.appointments ?? []) },
    professionalLocation: { findMany: jest.fn().mockResolvedValue(opts.links ?? []) },
  };
  const flags = { isEnabled: jest.fn().mockResolvedValue(true) };
  return { service: new MultiLocationService(prisma as any, flags as any), prisma };
}

describe("the plan limit counts active locations only", () => {
  it("creating counts only active ones", async () => {
    const { service, prisma } = makeService({ activeCount: 1, maxLocations: 2 });
    await service.create("t1", { name: "Norte" });
    expect(prisma.location.count).toHaveBeenCalledWith({ where: { tenantId: "t1", isActive: true } });
    expect(prisma.location.create).toHaveBeenCalled();
  });

  it("at the limit of active locations, creating is refused in Spanish", async () => {
    const { service, prisma } = makeService({ activeCount: 2, maxLocations: 2 });
    const err: any = await service.create("t1", { name: "Norte" }).catch((e) => e);
    expect(err.message).toMatch(/Tu plan Empresa incluye 2 locales activos/);
    // B8: it says how to get one more (each location is paid for), with a link.
    expect(err.message).toMatch(/añadir un local en Ajustes > Facturación/);
    expect(err.getResponse()).toEqual(expect.objectContaining({ code: "LOCATION_LIMIT_REACHED", billingUrl: "/dashboard/billing" }));
    expect(prisma.location.create).not.toHaveBeenCalled();
  });
});

describe("reactivating a location", () => {
  it("PATCH { isActive: true } brings an inactive one back when there is room", async () => {
    const { service, prisma } = makeService({ location: { isActive: false }, activeCount: 1, maxLocations: 2 });
    await expect(service.update("t1", "loc-1", { isActive: true })).resolves.toMatchObject({ isActive: true });
    expect(prisma.location.count).toHaveBeenCalledWith({ where: { tenantId: "t1", isActive: true } });
  });

  it("is refused when the active ones already fill the plan", async () => {
    const { service, prisma } = makeService({ location: { isActive: false }, activeCount: 2, maxLocations: 2 });
    await expect(service.update("t1", "loc-1", { isActive: true })).rejects.toThrow(BadRequestException);
    expect(prisma.location.update).not.toHaveBeenCalled();
  });

  it("saving an already active location does not check the limit", async () => {
    const { service, prisma } = makeService({ activeCount: 2, maxLocations: 2 });
    await service.update("t1", "loc-1", { isActive: true, name: "Centro" });
    expect(prisma.location.count).not.toHaveBeenCalled();
  });
});

describe("deactivation preview", () => {
  it("counts the location's pending and confirmed appointments from the salon's today", async () => {
    const { service, prisma } = makeService({
      appointments: [
        { locationId: "loc-1", professionalId: "p9" },
        { locationId: null, professionalId: "p1" }, // works only at loc-1
        { locationId: null, professionalId: "p2" }, // works at loc-2
        { locationId: null, professionalId: null },
      ],
      links: [
        { professionalId: "p1", locationId: "loc-1", isPrimary: true },
        { professionalId: "p2", locationId: "loc-2", isPrimary: true },
      ],
    });
    await expect(service.deactivationPreview("t1", "loc-1")).resolves.toEqual({ upcomingAppointments: 2 });
    const where = prisma.appointment.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({
      tenantId: "t1",
      status: { in: ["pending", "confirmed"] },
      OR: [{ locationId: "loc-1" }, { locationId: null }],
    });
    expect(where.scheduledDate.gte.toISOString()).toMatch(/T00:00:00.000Z$/);
  });

  it("only for the salon's own location", async () => {
    const { service, prisma } = makeService();
    prisma.location.findFirst.mockResolvedValueOnce(null);
    await expect(service.deactivationPreview("t1", "other")).rejects.toThrow(/no encontrado/);
    expect(prisma.location.findFirst).toHaveBeenCalledWith({ where: { id: "other", tenantId: "t1" } });
  });
});
