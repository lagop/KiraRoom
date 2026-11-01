import { ConflictException } from "@nestjs/common";
import { PromotionsService } from "./promotions.service";

/**
 * Promotions linked to re-engagement campaigns. A running campaign sends
 * its promotion's code every day, so deleting the promotion under it is
 * refused, and only promotions that can still be used are offered to link.
 */
describe("PromotionsService and campaigns", () => {
  function setup(linkedCampaign: { name: string } | null, uses = 0) {
    const prisma: any = {
      promotion: {
        findFirst: jest.fn(async () => ({ id: "p1", tenantId: "t1" })),
        findMany: jest.fn(async () => []),
        delete: jest.fn(async () => ({ id: "p1" })),
        update: jest.fn(async ({ data }: any) => ({ id: "p1", ...data })),
      },
      promotionUsage: { count: jest.fn(async () => uses) },
      emailCampaign: { findFirst: jest.fn(async () => linkedCampaign) },
      $queryRaw: jest.fn(async () => [{ id: "p1" }]),
    };
    prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
    return { service: new PromotionsService(prisma), prisma };
  }

  it("refuses, in Spanish, to delete a promotion an active campaign uses", async () => {
    const { service, prisma } = setup({ name: "Te echamos de menos" });
    const attempt = service.delete("p1", "t1");
    await expect(attempt).rejects.toBeInstanceOf(ConflictException);
    await expect(service.delete("p1", "t1")).rejects.toThrow(/se usa en la campaña «Te echamos de menos»/);
    expect(prisma.emailCampaign.findFirst.mock.calls[0][0].where).toEqual({
      tenantId: "t1",
      linkedPromotionId: "p1",
      status: { in: ["active", "scheduled", "sending"] },
    });
    expect(prisma.promotion.delete).not.toHaveBeenCalled();
  });

  it("deletes a promotion no running campaign uses and nobody used", async () => {
    const { service, prisma } = setup(null);
    expect(await service.delete("p1", "t1")).toEqual({ id: "p1", deleted: true, archived: false });
    expect(prisma.promotion.delete).toHaveBeenCalledWith({ where: { id: "p1" } });
    // Under the promotion's row lock, the one a sale's claim takes.
    expect(String(prisma.$queryRaw.mock.calls[0][0].join("?"))).toMatch(/FOR UPDATE/);
  });

  it("archives, instead of deleting, a promotion used at the till: its uses keep their promotion", async () => {
    const { service, prisma } = setup(null, 3);
    expect(await service.delete("p1", "t1")).toEqual({ id: "p1", deleted: false, archived: true });
    expect(prisma.promotion.delete).not.toHaveBeenCalled();
    expect(prisma.promotion.update).toHaveBeenCalledWith({
      where: { id: "p1" },
      data: { archivedAt: expect.any(Date), isActive: false },
    });
  });

  it("lists, offers and counts only promotions that are not archived", async () => {
    const { service, prisma } = setup(null);
    prisma.promotionUsage.aggregate = jest.fn(async () => ({ _sum: { discountAmount: 0 }, _count: 0 }));
    await service.getAll("t1");
    await service.getStatistics("t1");
    expect(prisma.promotion.findMany.mock.calls[0][0].where).toEqual({ tenantId: "t1", archivedAt: null });
    expect(prisma.promotion.findMany.mock.calls[1][0].where).toEqual({ tenantId: "t1", archivedAt: null });
  });

  it("counts in the statistics only the uses a refund did not release", async () => {
    const { service, prisma } = setup(null);
    prisma.promotion.findMany = jest.fn(async () => [{ id: "p1", name: "Otoño", code: "OTONO10", usedCount: 2 }]);
    prisma.promotionUsage.aggregate = jest.fn(async () => ({ _sum: { discountAmount: 7.5 }, _count: 2 }));
    expect(await service.getStatistics("t1")).toEqual([
      { id: "p1", name: "Otoño", code: "OTONO10", usedCount: 2, totalDiscount: 7.5, usageCount: 2 },
    ]);
    expect(prisma.promotionUsage.aggregate.mock.calls[0][0].where).toEqual({ promotionId: "p1", releasedAt: null });
  });

  it("refuses a code an archived promotion had, saying so", async () => {
    const { service, prisma } = setup(null);
    prisma.promotion.findFirst = jest.fn(async () => ({ archivedAt: new Date() }));
    await expect(
      service.create("t1", { name: "x", code: "otono10", type: "PERCENTAGE", value: 10, startDate: "2026-11-01" } as any),
    ).rejects.toThrow(/promoción que eliminaste/);
    expect(prisma.promotion.findFirst.mock.calls[0][0].where).toEqual({ tenantId: "t1", code: "OTONO10" });
  });

  it("refuses services of another salon", async () => {
    const { service, prisma } = setup(null);
    prisma.promotion.findFirst = jest.fn(async () => null);
    prisma.service = { count: jest.fn(async () => 0) };
    prisma.promotion.create = jest.fn();
    await expect(
      service.create("t1", {
        name: "x",
        code: "X",
        type: "PERCENTAGE",
        value: 10,
        startDate: "2026-11-01",
        applicableServiceIds: ["s-other"],
      } as any),
    ).rejects.toThrow(/no es de tu salón/);
    expect(prisma.service.count).toHaveBeenCalledWith({ where: { tenantId: "t1", id: { in: ["s-other"] } } });
    expect(prisma.promotion.create).not.toHaveBeenCalled();
  });

  it("offers only active promotions that have not ended", async () => {
    const { service, prisma } = setup(null);
    await service.getUsable("t1");
    const where = prisma.promotion.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ tenantId: "t1", isActive: true, archivedAt: null });
    expect(where.OR).toEqual([{ endDate: null }, { endDate: { gt: expect.any(Date) } }]);
  });

  it("answers in Spanish", async () => {
    const prisma: any = { promotion: { findFirst: jest.fn(async () => null) } };
    const service = new PromotionsService(prisma);
    await expect(service.getOne("x", "t1")).rejects.toThrow("Promoción no encontrada");
    expect(await service.validateCode("t1", "NOPE")).toEqual({ valid: false, message: "El código no es válido." });
    await expect(service.create("t1", { type: "PERCENTAGE", value: 150, code: "X" } as any)).rejects.toThrow(/100 %/);
  });
});
