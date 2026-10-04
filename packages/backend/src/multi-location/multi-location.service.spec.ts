/**
 * The Empresa plan is "activable desde 1 local" (minLocations: 1), but the
 * API still refused to deactivate a location if fewer than 2 would stay
 * active, and the consolidated report refused to run with fewer than 2. The
 * only rule left is not switching off the last active location -- through
 * DELETE or through PATCH { isActive: false }, which used to skip the check.
 */
import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { MultiLocationService } from "./multi-location.service";

function makeService(activeCount: number, flagEnabled = true) {
  const prisma = {
    location: {
      findFirst: jest.fn().mockResolvedValue({ id: "loc-1", name: "Centro", isActive: true }),
      count: jest.fn().mockResolvedValue(activeCount),
      update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: "loc-1", ...data })),
      findMany: jest.fn().mockResolvedValue([{ id: "loc-1", name: "Centro" }]),
    },
    tenant: { findUnique: jest.fn().mockResolvedValue({ timezone: "Europe/Madrid" }) },
    appointment: { findMany: jest.fn().mockResolvedValue([]) },
    professional: { findMany: jest.fn().mockResolvedValue([]) },
    professionalLocation: { findMany: jest.fn().mockResolvedValue([]) },
  };
  const flags = { isEnabled: jest.fn().mockResolvedValue(flagEnabled) };
  return { service: new MultiLocationService(prisma as any, flags as any), prisma };
}

describe("MultiLocationService", () => {
  it("lets an Empresa salon with two locations close one", async () => {
    const { service, prisma } = makeService(2);
    await expect(service.remove("t1", "loc-1")).resolves.toMatchObject({ isActive: false });
    expect(prisma.location.update).toHaveBeenCalled();
  });

  it("refuses to deactivate the last active location", async () => {
    const { service, prisma } = makeService(1);
    await expect(service.remove("t1", "loc-1")).rejects.toThrow(BadRequestException);
    await expect(service.update("t1", "loc-1", { isActive: false })).rejects.toThrow(
      BadRequestException,
    );
    expect(prisma.location.update).not.toHaveBeenCalled();
  });

  it("still lets the last location be renamed", async () => {
    const { service } = makeService(1);
    await expect(service.update("t1", "loc-1", { name: "Centro Sur" })).resolves.toMatchObject({
      name: "Centro Sur",
    });
  });

  it("builds the consolidated report from one active location", async () => {
    const { service, prisma } = makeService(1);
    const report = await service.getConsolidated("t1", "last_month");
    expect(report.range).toBe("last_month");
    expect(report.activeLocations).toBe(1);
    expect(report.perLocation.map((l) => l.name)).toEqual(["Centro"]);
    // The period is the salon's previous calendar month.
    const where = prisma.appointment.findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe("t1");
    expect(where.scheduledDate.gte.toISOString().slice(8, 10)).toBe("01");
  });

  it("refuses the report without the plan feature or without locations", async () => {
    await expect(makeService(2, false).service.getConsolidated("t1")).rejects.toThrow(
      ForbiddenException,
    );
    await expect(makeService(0).service.getConsolidated("t1")).rejects.toThrow(
      BadRequestException,
    );
  });
});
