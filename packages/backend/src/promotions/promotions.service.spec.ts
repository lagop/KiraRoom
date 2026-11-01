import { ConflictException } from "@nestjs/common";
import { PromotionsService } from "./promotions.service";

/**
 * Promotions linked to re-engagement campaigns. A running campaign sends
 * its promotion's code every day, so deleting the promotion under it is
 * refused, and only promotions that can still be used are offered to link.
 */
describe("PromotionsService and campaigns", () => {
  function setup(linkedCampaign: { name: string } | null) {
    const prisma: any = {
      promotion: {
        findFirst: jest.fn(async () => ({ id: "p1", tenantId: "t1" })),
        findMany: jest.fn(async () => []),
        delete: jest.fn(async () => ({ id: "p1" })),
      },
      emailCampaign: { findFirst: jest.fn(async () => linkedCampaign) },
    };
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

  it("deletes a promotion no running campaign uses", async () => {
    const { service, prisma } = setup(null);
    await service.delete("p1", "t1");
    expect(prisma.promotion.delete).toHaveBeenCalledWith({ where: { id: "p1" } });
  });

  it("offers only active promotions that have not ended", async () => {
    const { service, prisma } = setup(null);
    await service.getUsable("t1");
    const where = prisma.promotion.findMany.mock.calls[0][0].where;
    expect(where).toMatchObject({ tenantId: "t1", isActive: true });
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
