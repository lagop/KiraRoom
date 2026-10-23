import { NotFoundException } from "@nestjs/common";
import { QrController } from "./qr.controller";

/**
 * "Comparte tu página" draws its QR codes in the browser from the address
 * GET /qr/share returns, so it must be the salon's real one; and the QR
 * endpoints must put a professional or service filter on that same address.
 */
describe("QrController", () => {
  const env = { ...process.env };
  beforeEach(() => {
    process.env.APP_BASE_URL = "https://app.kiraroom.net";
    process.env.SALON_SUBDOMAIN_BASE = "kiraroom.net";
    process.env.SALON_SUBDOMAINS_READY = "1";
    delete process.env.CUSTOM_DOMAINS_TLS_READY;
  });
  afterAll(() => {
    process.env = env;
  });

  const tenant = { name: "Salón Lucía", slug: "salon-lucia", logo: null, customDomain: null };
  const controller = (row: unknown) =>
    new QrController({ tenant: { findUnique: jest.fn().mockResolvedValue(row) } } as any);

  it("shares the salon's name, logo and real address", async () => {
    await expect(controller(tenant).share({ tenantId: "t1" })).resolves.toEqual({
      name: "Salón Lucía",
      slug: "salon-lucia",
      logo: null,
      url: "https://salon-lucia.kiraroom.net",
    });
  });

  it("gives the own domain once it is served", async () => {
    process.env.CUSTOM_DOMAINS_TLS_READY = "1";
    const row = { ...tenant, customDomain: { domain: "reservas.salonlucia.es", verifiedAt: new Date() } };
    await expect(controller(row).share({ tenantId: "t1" })).resolves.toMatchObject({ url: "https://reservas.salonlucia.es" });
  });

  it("404s for an unknown salon", async () => {
    await expect(controller(null).share({ tenantId: "t1" })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("puts the filter on the same address the dashboard uses", () => {
    const url = (controller(tenant) as any).publicSiteUrl(tenant, "?professionalId=p-1");
    expect(url).toBe("https://salon-lucia.kiraroom.net/?professionalId=p-1");
    process.env.SALON_SUBDOMAINS_READY = "";
    expect((controller(tenant) as any).publicSiteUrl(tenant, "?serviceId=s-1")).toBe(
      "https://app.kiraroom.net/sites/salon-lucia?serviceId=s-1",
    );
  });
});
