import { BadRequestException } from "@nestjs/common";
import {
  RESERVED_SUBDOMAINS,
  isSalonSubdomainSlug,
  salonSubdomainHost,
  slugFromSalonSubdomain,
} from "@kira/shared";
import { WebDomainService } from "./web-domain.service";
import { assertTenantSlugAvailable, slugify } from "../saas/saas.helpers";

/**
 * Every salon's free address, <slug>.kiraroom.net. A slug is usable as a
 * subdomain when it is a valid DNS label and not a name the platform keeps;
 * the address becomes the canonical one only once the wildcard certificate
 * serves it (SALON_SUBDOMAINS_READY), so turning on the base alone changes
 * nothing visible.
 */

describe("salon subdomain rules (@kira/shared)", () => {
  it("accepts ordinary slugs and refuses reserved names, ids and invalid labels", () => {
    expect(isSalonSubdomainSlug("salon-lucia")).toBe(true);
    expect(isSalonSubdomainSlug("app")).toBe(false);
    expect(isSalonSubdomainSlug("api")).toBe(false);
    expect(isSalonSubdomainSlug("3f2a9c1e-77b1-4c2d-9e10-aa55cc66dd77")).toBe(false);
    expect(isSalonSubdomainSlug("-salon")).toBe(false);
    expect(isSalonSubdomainSlug("salon_lucia")).toBe(false);
    expect(isSalonSubdomainSlug("a".repeat(64))).toBe(false);
    expect(RESERVED_SUBDOMAINS.has("www")).toBe(true);
  });

  it("builds and reads the host", () => {
    expect(salonSubdomainHost("salon-lucia", "KiraRoom.net.")).toBe("salon-lucia.kiraroom.net");
    expect(salonSubdomainHost("app", "kiraroom.net")).toBeNull();
    expect(salonSubdomainHost("salon-lucia", "")).toBeNull();
    expect(slugFromSalonSubdomain("Salon-Lucia.kiraroom.net.", "kiraroom.net")).toBe("salon-lucia");
    expect(slugFromSalonSubdomain("app.kiraroom.net", "kiraroom.net")).toBeNull();
    expect(slugFromSalonSubdomain("kiraroom.net", "kiraroom.net")).toBeNull();
    expect(slugFromSalonSubdomain("a.b.kiraroom.net", "kiraroom.net")).toBeNull();
    expect(slugFromSalonSubdomain("salon-lucia.otro.com", "kiraroom.net")).toBeNull();
    expect(slugFromSalonSubdomain("salon-lucia.kiraroom.net", undefined)).toBeNull();
  });
});

describe("WebDomainService subdomain", () => {
  function service(env: Record<string, string>) {
    const config = { get: (k: string) => ({ APP_BASE_URL: "https://app.kiraroom.net", ...env })[k] };
    const prisma: any = {
      tenant: { findUnique: jest.fn(async () => ({ slug: "salon-lucia" })) },
      customDomain: { findFirst: jest.fn(async () => null) },
    };
    const dns: any = { resolve4: async () => [] };
    return new WebDomainService(prisma, config as any, dns);
  }

  it("stays on /sites/<slug> until subdomains are ready", async () => {
    const status = await service({ SALON_SUBDOMAIN_BASE: "kiraroom.net" }).getStatus("t1");
    expect(status.publicUrl).toBe("https://app.kiraroom.net/sites/salon-lucia");
    expect(status.subdomain).toEqual({ host: "salon-lucia.kiraroom.net", active: false });
  });

  it("uses the subdomain once ready", async () => {
    const svc = service({ SALON_SUBDOMAIN_BASE: "kiraroom.net", SALON_SUBDOMAINS_READY: "1" });
    const status = await svc.getStatus("t1");
    expect(status.publicUrl).toBe("https://salon-lucia.kiraroom.net");
    expect(status.subdomain).toEqual({ host: "salon-lucia.kiraroom.net", active: true });
    expect(svc.liveSubdomain("salon-lucia")).toBe("salon-lucia.kiraroom.net");
    expect(svc.liveSubdomain("app")).toBeNull();
  });

  it("has no subdomain without a base, even if READY is set", async () => {
    const svc = service({ SALON_SUBDOMAINS_READY: "1" });
    expect((await svc.getStatus("t1")).subdomain).toBeNull();
    expect(svc.subdomainsReady()).toBe(false);
  });
});

describe("salon slugs", () => {
  it("fold accents instead of turning them into hyphens", () => {
    // It used to give "sal-n-luc-a".
    expect(slugify("Salón Lucía")).toBe("salon-lucia");
    expect(slugify("Peluquería Muñoz & Hijos")).toBe("peluqueria-munoz-hijos");
  });

  it("fit in a DNS label (63 characters, no trailing hyphen)", () => {
    const slug = slugify(`${"Barbería ".repeat(10)}Final`);
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("cannot be a reserved name", async () => {
    const prisma: any = { tenant: { findUnique: jest.fn(async () => null) } };
    await expect(assertTenantSlugAvailable(prisma, "app")).rejects.toBeInstanceOf(BadRequestException);
    await expect(assertTenantSlugAvailable(prisma, "salon-lucia")).resolves.toBeUndefined();
  });
});
