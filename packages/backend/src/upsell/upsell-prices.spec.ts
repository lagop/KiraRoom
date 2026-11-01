import { UpsellService } from "./upsell.service";

/**
 * The receptionist reads these suggestions to clients ("te pueden
 * interesar: ... 36.30€"), so their prices are the final ones, tax included.
 */
function build(fiscalSettings: unknown) {
  const prisma: any = {
    appointment: { findFirst: jest.fn(async () => null) },
    service: {
      findMany: jest.fn(async () => [{ id: "s1", name: "Corte", duration: 30, price: "30.00", category: "hair" }]),
    },
    tenant: { findUnique: jest.fn(async () => ({ fiscalSettings })) },
  };
  const flags: any = { isFeatureUnlocked: jest.fn(async () => true) };
  return new UpsellService(prisma, flags);
}

describe("UpsellService.suggest prices", () => {
  it("adds the salon's IVA to a net catalogue price", async () => {
    const [s] = await build({ pricesIncludeTax: false, defaultTaxRate: 21 }).suggest("t1");
    expect(s).toMatchObject({ price: 36.3, taxLabel: "IVA" });
  });

  it("keeps a price that already includes the tax, and names IGIC in the Canaries", async () => {
    const [s] = await build({ pricesIncludeTax: true, defaultTaxRate: 7, taxRegime: "igic" }).suggest("t1");
    expect(s).toMatchObject({ price: 30, taxLabel: "IGIC" });
  });
});
