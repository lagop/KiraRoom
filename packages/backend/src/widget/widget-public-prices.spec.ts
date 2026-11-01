import { WidgetService } from "./widget.service";

/**
 * The embeddable widget shows the salon's services with their prices to
 * clients: the final price, tax included (common/public-price.ts), never the
 * net catalogue figure of a salon that writes its prices without the IVA.
 */

function build(fiscalSettings: unknown) {
  const prisma: any = {
    widgetInstance: {
      findUnique: jest.fn(async () => ({
        id: "w1",
        tenantId: "t1",
        name: "Landing",
        allowedOrigins: [],
        theme: {},
        services: [],
        professionals: [],
        tenant: {
          id: "t1",
          name: "Salón Luna",
          slug: "salon-luna",
          logo: null,
          coverImage: null,
          city: "Madrid",
          country: "ES",
          timezone: "Europe/Madrid",
          currency: "EUR",
          language: "es",
          fiscalSettings,
          stripeLiveSecretKey: "sk_live_never_sent",
        },
      })),
    },
    professional: { findMany: jest.fn(async () => []) },
    service: {
      findMany: jest.fn(async () => [
        { id: "s1", name: "Corte", description: null, category: "hair", duration: 30, price: "30.00", currency: "EUR", images: [] },
      ]),
    },
    // salonWhatsAppConnected: no WhatsApp number connected.
    whatsAppConnection: { findUnique: jest.fn(async () => null) },
  };
  return new WidgetService(prisma);
}

describe("WidgetService.getPublicConfig prices", () => {
  it("a net catalogue is shown with the IVA the invoice adds: 30,00 -> 36,30", async () => {
    const config = await build({ pricesIncludeTax: false, defaultTaxRate: 21 }).getPublicConfig("w1");
    expect(config.services[0].price).toBe(36.3);
    expect(config.tenant.taxLabel).toBe("IVA");
  });

  it("a catalogue that includes the tax is shown as stored; IGIC in the Canaries", async () => {
    const included = await build({ pricesIncludeTax: true, defaultTaxRate: 7, taxRegime: "igic" }).getPublicConfig("w1");
    expect(included.services[0].price).toBe(30);
    expect(included.tenant.taxLabel).toBe("IGIC");
  });

  it("sends neither the fiscal settings nor any other tenant column", async () => {
    const config = await build({ pricesIncludeTax: false, tenantNif: "B12345678" }).getPublicConfig("w1");
    const json = JSON.stringify(config);
    expect(json).not.toContain("B12345678");
    expect(json).not.toContain("sk_live");
    expect(config.tenant).not.toHaveProperty("fiscalSettings");
  });
});
