import { NotFoundException } from "@nestjs/common";
import { PublicSiteService } from "./public-site.service";

/**
 * The data behind a salon's server-rendered public page, its sitemap entry
 * and its custom-domain lookup. All three are anonymous endpoints.
 *
 * What it guards:
 *  - only public fields leave (#97 leaked salon keys and client rows through
 *    a response that returned whole records): the queries use explicit
 *    selects without keys, Stripe ids or staff contact details;
 *  - deleted salons and inactive services/professionals are not shown;
 *  - the canonical custom domain is reported only once it is verified AND
 *    served over HTTPS;
 *  - the host lookup only answers for verified domains.
 */

const FORBIDDEN_SELECT_KEYS = [
  "stripeTestSecretKey",
  "stripeLiveSecretKey",
  "stripeCustomerId",
  "stripeSubscriptionId",
  "taxId",
  "addons",
  "features",
  "verificationToken",
  "commissionRate",
  "userId",
  "clients",
];

function selectKeys(select: any, prefix = ""): string[] {
  return Object.entries(select ?? {}).flatMap(([k, v]: [string, any]) =>
    v && typeof v === "object" && v.select ? [prefix + k, ...selectKeys(v.select, `${prefix}${k}.`)] : [prefix + k],
  );
}

function makeService({ tlsReady = false, tenant = {} as any } = {}) {
  const prisma = {
    tenant: {
      findFirst: jest.fn(async () =>
        tenant === null
          ? null
          : {
              id: "t1",
              name: "Salón Luna",
              slug: "salon-luna",
              description: "Peluquería en el centro",
              logo: null,
              coverImage: null,
              website: null,
              email: "hola@salonluna.example",
              phone: "+34 600 000 000",
              street: "Calle Mayor 1",
              city: "Madrid",
              state: "Madrid",
              postalCode: "28013",
              country: "ES",
              currency: "EUR",
              timezone: "Europe/Madrid",
              language: "es",
              updatedAt: new Date("2026-10-01T10:00:00Z"),
              customDomain: null,
              ...tenant,
            },
      ),
      findMany: jest.fn(async () => [
        { slug: "a", updatedAt: new Date("2026-10-01"), customDomain: null },
        { slug: "b", updatedAt: new Date("2026-09-01"), customDomain: { domain: "b.example.com", verifiedAt: new Date() } },
      ]),
    },
    service: {
      findMany: jest.fn(async () => [
        { id: "s1", name: "Corte", description: null, duration: 30, price: { toString: () => "18.5", valueOf: () => 18.5 }, currency: "EUR", category: "hair" },
      ]),
    },
    professional: {
      findMany: jest.fn(async () => [
        {
          id: "p1",
          firstName: "Ana",
          lastName: "García",
          profileImage: null,
          bio: null,
          position: "Estilista",
          specialties: [],
          portfolioImages: [],
          yearsExperience: null,
          languages: [],
          certifications: [],
          workingHours: [
            { day: "monday", openTime: "09:00", closeTime: "18:00" },
            { day: "saturday", openTime: "10:00", closeTime: "14:00" },
          ],
          services: [{ serviceId: "s1" }],
        },
      ]),
    },
    customDomain: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.domain === "reservas.salonluna.es" ? { tenant: { slug: "salon-luna" } } : null,
      ),
    },
  };
  const webDomain = { servingEnabled: () => tlsReady };
  return { svc: new PublicSiteService(prisma as any, webDomain as any), prisma };
}

describe("PublicSiteService.getPage", () => {
  it("returns the page data with numbers, hours and no per-person schedules", async () => {
    const { svc } = makeService();
    const page = await svc.getPage("salon-luna");
    expect(page.services).toEqual([
      { id: "s1", name: "Corte", description: null, duration: 30, price: 18.5, currency: "EUR", category: "hair" },
    ]);
    expect(page.openingHours).toEqual({
      monday: { openTime: "09:00", closeTime: "18:00" },
      saturday: { openTime: "10:00", closeTime: "14:00" },
    });
    expect(page.professionals[0]).not.toHaveProperty("workingHours");
    expect(page.professionals[0].services).toEqual([{ serviceId: "s1" }]);
    expect(page.address).toEqual({ street: "Calle Mayor 1", city: "Madrid", state: "Madrid", postalCode: "28013", country: "ES" });
  });

  it("selects only public fields and only live rows", async () => {
    const { svc, prisma } = makeService();
    await svc.getPage("salon-luna");

    const tenantArgs = (prisma.tenant.findFirst.mock.calls[0] as any[])[0];
    const serviceArgs = (prisma.service.findMany.mock.calls[0] as any[])[0];
    const proArgs = (prisma.professional.findMany.mock.calls[0] as any[])[0];
    const selected = [
      ...selectKeys(tenantArgs.select),
      ...selectKeys(serviceArgs.select),
      ...selectKeys(proArgs.select),
    ];
    for (const key of FORBIDDEN_SELECT_KEYS) {
      expect(selected.some((s) => s.split(".").includes(key))).toBe(false);
    }
    // Staff contact details stay private.
    expect(selectKeys(proArgs.select)).not.toEqual(expect.arrayContaining(["email"]));
    expect(selectKeys(proArgs.select)).not.toEqual(expect.arrayContaining(["phone"]));

    expect(tenantArgs.where.deletedAt).toBeNull();
    expect(serviceArgs.where).toEqual({ tenantId: "t1", isActive: true });
    expect(proArgs.where).toEqual({ tenantId: "t1", isActive: true });
  });

  it("404s for an unknown or deleted salon", async () => {
    const { svc } = makeService({ tenant: null });
    await expect(svc.getPage("nope")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("reports the custom domain as canonical only when verified and served over HTTPS", async () => {
    const verified = { customDomain: { domain: "reservas.salonluna.es", verifiedAt: new Date() } };
    expect((await makeService({ tenant: verified }).svc.getPage("x")).customDomain).toBeNull();
    expect((await makeService({ tenant: verified, tlsReady: true }).svc.getPage("x")).customDomain).toBe(
      "reservas.salonluna.es",
    );
    const pending = { customDomain: { domain: "reservas.salonluna.es", verifiedAt: null } };
    expect((await makeService({ tenant: pending, tlsReady: true }).svc.getPage("x")).customDomain).toBeNull();
  });
});

describe("PublicSiteService.listForSitemap", () => {
  it("lists live, active salons with something to book", async () => {
    const { svc, prisma } = makeService({ tlsReady: true });
    const out = await svc.listForSitemap();
    const args = (prisma.tenant.findMany.mock.calls[0] as any[])[0];
    expect(args.where).toEqual({
      deletedAt: null,
      subscriptionStatus: { in: ["active", "trialing", "past_due"] },
      services: { some: { isActive: true } },
    });
    expect(selectKeys(args.select).sort()).toEqual(
      ["customDomain", "customDomain.domain", "customDomain.verifiedAt", "slug", "updatedAt"].sort(),
    );
    expect(out.map((s) => s.customDomain)).toEqual([null, "b.example.com"]);
  });
});

describe("PublicSiteService.resolveHost", () => {
  it("answers with the slug for a verified domain, normalising the host", async () => {
    const { svc, prisma } = makeService();
    await expect(svc.resolveHost("Reservas.SalonLuna.es.")).resolves.toEqual({ slug: "salon-luna" });
    const args = (prisma.customDomain.findFirst.mock.calls[0] as any[])[0];
    expect(args.where).toEqual({
      domain: "reservas.salonluna.es",
      verifiedAt: { not: null },
      tenant: { deletedAt: null },
    });
  });

  it("404s for unknown hosts and garbage", async () => {
    const { svc } = makeService();
    await expect(svc.resolveHost("otro.example.com")).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.resolveHost("not a host")).rejects.toBeInstanceOf(NotFoundException);
  });
});
