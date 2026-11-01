import { NotFoundException } from "@nestjs/common";
import { QrController } from "./qr.controller";

/**
 * "Comparte tu página" draws its QR codes in the browser from the address
 * GET /qr/share returns, so it must be the salon's real one, and say when
 * it is the salon's own domain (printed codes depend on keeping it).
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
      ownDomain: false,
    });
  });

  it("gives the own domain once it is served, and says so", async () => {
    process.env.CUSTOM_DOMAINS_TLS_READY = "1";
    const row = { ...tenant, customDomain: { domain: "reservas.salonlucia.es", verifiedAt: new Date() } };
    await expect(controller(row).share({ tenantId: "t1" })).resolves.toMatchObject({
      url: "https://reservas.salonlucia.es",
      ownDomain: true,
    });
  });

  it("a domain not served yet is not the address", async () => {
    const row = { ...tenant, customDomain: { domain: "reservas.salonlucia.es", verifiedAt: new Date() } };
    await expect(controller(row).share({ tenantId: "t1" })).resolves.toMatchObject({ ownDomain: false });
  });

  it("404s for an unknown salon", async () => {
    await expect(controller(null).share({ tenantId: "t1" })).rejects.toBeInstanceOf(NotFoundException);
  });

  it("has no public QR image endpoints any more", () => {
    for (const gone of ["salonQr", "professionalQr", "serviceQr"]) {
      expect((QrController.prototype as any)[gone]).toBeUndefined();
    }
  });
});
