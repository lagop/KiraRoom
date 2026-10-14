import { ForbiddenException } from "@nestjs/common";
import { assertProfessionalSlot } from "./professional-limit";

/**
 * Esencial allows 4 active professionals, Pro 10, Empresa any number. The
 * limit was only displayed, never checked.
 */
function prismaWith(tenant: any, active: number) {
  return {
    tenant: { findUnique: jest.fn().mockResolvedValue(tenant) },
    professional: { count: jest.fn().mockResolvedValue(active) },
  } as any;
}
const DAY = 86_400_000;
const esencial = { plan: "esencial", subscriptionStatus: "active", trialEnd: null };

describe("assertProfessionalSlot", () => {
  it("refuses the 5th active professional on Esencial and the 11th on Pro", async () => {
    await expect(assertProfessionalSlot(prismaWith(esencial, 4), "t1")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      assertProfessionalSlot(prismaWith({ ...esencial, plan: "pro" }, 10), "t1"),
    ).rejects.toMatchObject({ response: { code: "PROFESSIONAL_LIMIT_REACHED", limit: 10 } });
  });

  it("allows up to the limit, counting active professionals only", async () => {
    const prisma = prismaWith(esencial, 3);
    await expect(assertProfessionalSlot(prisma, "t1")).resolves.toBeUndefined();
    expect(prisma.professional.count).toHaveBeenCalledWith({ where: { tenantId: "t1", isActive: true } });
  });

  it("has no limit on Empresa", async () => {
    const prisma = prismaWith({ ...esencial, plan: "empresa" }, 250);
    await expect(assertProfessionalSlot(prisma, "t1")).resolves.toBeUndefined();
    expect(prisma.professional.count).not.toHaveBeenCalled();
  });

  it("treats the trial as Pro, and an ended trial as the stored plan", async () => {
    const trial = { plan: "esencial", subscriptionStatus: "trialing", trialEnd: new Date(Date.now() + DAY) };
    await expect(assertProfessionalSlot(prismaWith(trial, 6), "t1")).resolves.toBeUndefined();
    await expect(
      assertProfessionalSlot(prismaWith({ ...trial, trialEnd: new Date(Date.now() - DAY) }, 6), "t1"),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("reads legacy plan names", async () => {
    await expect(assertProfessionalSlot(prismaWith({ ...esencial, plan: "basic" }, 4), "t1")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });
});
