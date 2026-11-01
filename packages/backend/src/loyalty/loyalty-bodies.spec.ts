import { LoyaltyController } from "./loyalty.controller";
import { LoyaltyRewardDto, UpdateLoyaltyRewardDto, discountValueProblem } from "./loyalty.dto";
import { bodyMetatype, bodyParser } from "../common/validation/validated-body.testing";

/**
 * L6: a "discount" reward with 0 % and 0,00 EUR used to be accepted (and
 * took nothing off at the till), and so was one with both. The bodies now
 * refuse it, in Spanish, before the service sees it; the service checks an
 * edit again as the reward will stand (loyalty.service.spec.ts).
 */
describe("loyalty reward bodies", () => {
  it("are validated classes", () => {
    expect(bodyMetatype(LoyaltyController, "createReward")).toBe(LoyaltyRewardDto);
    expect(bodyMetatype(LoyaltyController, "updateReward")).toBe(UpdateLoyaltyRewardDto);
  });

  describe("POST /loyalty/rewards", () => {
    const parse = bodyParser(LoyaltyController, "createReward");
    const base = { name: "Descuento", type: "discount", pointsCost: 100 };

    it("takes a percent or an amount", async () => {
      await expect(parse({ ...base, discountPercent: 10 })).resolves.toMatchObject({ discountPercent: 10 });
      await expect(parse({ ...base, discountAmount: 500, discountPercent: 0 })).resolves.toMatchObject({ discountAmount: 500 });
    });

    it("refuses neither, or both", async () => {
      await expect(parse({ ...base })).rejects.toBeDefined();
      await expect(parse({ ...base, discountPercent: 0, discountAmount: 0 })).rejects.toBeDefined();
      await expect(parse({ ...base, discountPercent: 10, discountAmount: 500 })).rejects.toBeDefined();
    });

    it("other types need no discount", async () => {
      await expect(parse({ ...base, type: "product" })).resolves.toMatchObject({ type: "product" });
    });

    it("takes a limit of uses and an expiry, or none", async () => {
      await expect(
        parse({ ...base, discountPercent: 10, maxRedemptions: 20, expiresAt: "2026-12-31T22:59:59.999Z" }),
      ).resolves.toMatchObject({ maxRedemptions: 20, expiresAt: "2026-12-31T22:59:59.999Z" });
      await expect(parse({ ...base, discountPercent: 10, maxRedemptions: 0 })).rejects.toBeDefined();
      await expect(parse({ ...base, discountPercent: 10, expiresAt: "mañana" })).rejects.toBeDefined();
    });
  });

  describe("PUT /loyalty/rewards/:id", () => {
    const parse = bodyParser(LoyaltyController, "updateReward");

    it("lets one field change at a time, and null clear the limit and the expiry", async () => {
      await expect(parse({ pointsCost: 150 })).resolves.toMatchObject({ pointsCost: 150 });
      await expect(parse({ isActive: false })).resolves.toMatchObject({ isActive: false });
      await expect(parse({ maxRedemptions: null, expiresAt: null })).resolves.toMatchObject({ maxRedemptions: null, expiresAt: null });
    });

    it("refuses a percent and an amount at once", async () => {
      await expect(parse({ discountPercent: 10, discountAmount: 500 })).rejects.toBeDefined();
      await expect(parse({ discountPercent: 0, discountAmount: 500 })).resolves.toBeDefined();
    });
  });

  it("explains the problem in Spanish", () => {
    expect(discountValueProblem("discount", 0, 0)).toMatch(/porcentaje o un importe fijo mayor que 0/);
    expect(discountValueProblem("discount", 5, 100)).toMatch(/no los dos/);
    expect(discountValueProblem("discount", 5, null)).toBeNull();
    expect(discountValueProblem("free_service", 0, 0)).toBeNull();
  });
});
