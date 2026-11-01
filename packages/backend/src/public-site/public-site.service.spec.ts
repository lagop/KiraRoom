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

function makeService({ tlsReady = false, subdomains = false, tenant = {} as any } = {}) {
  const prisma = {
    // No time off recorded (time-off-query.ts).
    timeOff: { findMany: jest.fn(async () => []) },
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
              // A new salon: its catalogue already includes the IVA.
              fiscalSettings: { pricesIncludeTax: true, defaultTaxRate: 21, taxRegime: "iva", tenantNif: "B12345678" },
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
  const webDomain = {
    servingEnabled: () => tlsReady,
    liveSubdomain: (slug: string) => (subdomains ? `${slug}.kiraroom.net` : null),
  };
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
    expect(page.openingShifts).toEqual({
      monday: [{ openTime: "09:00", closeTime: "18:00" }],
      saturday: [{ openTime: "10:00", closeTime: "14:00" }],
    });
    expect(page.professionals[0]).not.toHaveProperty("workingHours");
    expect(page.professionals[0].services).toEqual([{ serviceId: "s1" }]);
    expect(page.address).toEqual({ street: "Calle Mayor 1", city: "Madrid", state: "Madrid", postalCode: "28013", country: "ES" });
  });

  it("prices are the final ones, tax included, whatever way the catalogue is written", async () => {
    // Catalogue with the IVA inside: shown as stored.
    const included = await makeService().svc.getPage("x");
    expect(included.services[0].price).toBe(18.5);
    expect(included.taxLabel).toBe("IVA");

    // Net catalogue: the IVA the invoice adds is in the price shown.
    const net = await makeService({ tenant: { fiscalSettings: { pricesIncludeTax: false, defaultTaxRate: 21 } } }).svc.getPage("x");
    expect(net.services[0].price).toBe(22.39); // 18,50 + 3,885 -> 3,89
    expect(net.taxLabel).toBe("IVA");

    // A salon from before the setting: no key, net, as its invoices are.
    const legacy = await makeService({ tenant: { fiscalSettings: {} } }).svc.getPage("x");
    expect(legacy.services[0].price).toBe(22.39);

    // The Canaries: IGIC 7 %.
    const canary = await makeService({
      tenant: { fiscalSettings: { pricesIncludeTax: false, defaultTaxRate: 7, taxRegime: "igic" } },
    }).svc.getPage("x");
    expect(canary.services[0].price).toBe(19.8); // 18,50 + 1,295 -> 1,30
    expect(canary.taxLabel).toBe("IGIC");
  });

  it("never sends the salon's fiscal settings, only the label of its tax", async () => {
    const page = await makeService().svc.getPage("x");
    expect(page).not.toHaveProperty("fiscalSettings");
    expect(JSON.stringify(page)).not.toContain("B12345678");
  });

  it("shows the salon's own hours when it set them, not its professionals'", async () => {
    const { svc } = makeService({
      tenant: {
        openingHours: [
          { day: "monday", openTime: "10:00", closeTime: "14:00" },
          { day: "monday", openTime: "17:00", closeTime: "20:00" },
          { day: "friday", openTime: "10:00", closeTime: "14:00" },
        ],
      },
    });
    const page = await svc.getPage("salon-luna");
    expect(page.openingShifts).toEqual({
      monday: [
        { openTime: "10:00", closeTime: "14:00" },
        { openTime: "17:00", closeTime: "20:00" },
      ],
      friday: [{ openTime: "10:00", closeTime: "14:00" }],
    });
    expect(page.openingHours).toEqual({
      monday: { openTime: "10:00", closeTime: "20:00" },
      friday: { openTime: "10:00", closeTime: "14:00" },
    });
    // Saturday is Ana's, not the salon's: not an open day. And the stored
    // value never leaves as it is.
    expect(page.openingShifts).not.toHaveProperty("saturday");
    expect(Array.isArray(page.openingHours)).toBe(false);
  });

  it("sends the salon's Instagram and Facebook from its general settings, null when unset", async () => {
    const page = await makeService({
      tenant: {
        instagram: "https://www.instagram.com/salonluna/",
        facebook: "https://www.facebook.com/salonluna",
      },
    }).svc.getPage("x");
    expect(page.instagram).toBe("https://www.instagram.com/salonluna/");
    expect(page.facebook).toBe("https://www.facebook.com/salonluna");

    const bare = await makeService({ tenant: { instagram: null, facebook: null } }).svc.getPage("x");
    expect(bare.instagram).toBeNull();
    expect(bare.facebook).toBeNull();
  });

  it("reads the legacy { open, close } as every day", async () => {
    const page = await makeService({ tenant: { openingHours: { open: "09:00", close: "20:00" } } }).svc.getPage("x");
    expect(Object.keys(page.openingHours)).toHaveLength(7);
    expect(page.openingHours.sunday).toEqual({ openTime: "09:00", closeTime: "20:00" });
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

  it("lists the days the salon is closed, from today on, as bare dates", async () => {
    const { svc, prisma } = makeService();
    const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(new Date());
    const at = (offset: number) => new Date(Date.parse(`${today}T00:00:00.000Z`) + offset * 86_400_000);
    const day = (offset: number) => at(offset).toISOString().slice(0, 10);
    prisma.timeOff.findMany.mockImplementation((async () => [
      // Started yesterday: only today and tomorrow are still ahead.
      { professionalId: null, kind: "closure", startDate: at(-1), endDate: at(1) },
      { professionalId: null, kind: "closure", startDate: at(10), endDate: at(10) },
    ]) as any);

    const page = await svc.getPage("salon-luna");

    expect(page.closedDays).toEqual([day(0), day(1), day(10)]);
    const args = (prisma.timeOff.findMany.mock.calls[0] as any[])[0];
    // The salon's whole-day closures only: no professional's time off, and
    // nothing but dates leaves the database (no note).
    expect(args.where).toMatchObject({ tenantId: "t1", professionalId: null, startTime: null, status: "approved" });
    expect(Object.keys(args.select)).not.toContain("note");
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
  it("gives the salon's subdomain only once subdomains are live", async () => {
    // The free address (salon-luna.kiraroom.net) becomes the canonical URL
    // only when the wildcard certificate serves it; WebDomainService decides.
    expect((await makeService().svc.getPage("x")).subdomainHost).toBeNull();
    const page = await makeService({ subdomains: true }).svc.getPage("x");
    expect(page.subdomainHost).toBe(`${page.slug}.kiraroom.net`);
    const sitemap = await makeService({ subdomains: true }).svc.listForSitemap();
    expect(sitemap.every((r) => r.subdomainHost === `${r.slug}.kiraroom.net`)).toBe(true);
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
