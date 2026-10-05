import { Injectable, NotFoundException } from "@nestjs/common";
import { SubscriptionStatus } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { salonWeekFrom, SalonDayWindow } from "../appointments/working-hours";
import { normalizeDomain } from "../web-domain/custom-domain";
import { WebDomainService } from "../web-domain/web-domain.service";

/**
 * Salons whose page is worth listing in the sitemap. A cancelled or
 * suspended salon keeps its URL working (old links, the client portal) but
 * we stop inviting search engines to it.
 */
const LISTED_STATUSES: SubscriptionStatus[] = ["active", "trialing", "past_due"];

/**
 * Everything the salon's public page shows, in one answer, with only public
 * fields.
 *
 * The page used to be a client component that fetched three endpoints after
 * load, so a crawler saw a spinner and nothing else. The frontend now renders
 * it on the server from this. One request instead of three also matters
 * because every server-side render comes from the same address and shares
 * one rate-limit bucket.
 *
 * Written as explicit `select`s on purpose (#97 leaked salon keys and client
 * rows through a response that returned whole records): adding a column to
 * Tenant or Professional must not add it here.
 */
@Injectable()
export class PublicSiteService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly webDomain: WebDomainService,
  ) {}

  async getPage(slugOrId: string) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { OR: [{ slug: slugOrId }, { id: slugOrId }], deletedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        description: true,
        logo: true,
        coverImage: true,
        website: true,
        email: true,
        phone: true,
        street: true,
        city: true,
        state: true,
        postalCode: true,
        country: true,
        currency: true,
        timezone: true,
        language: true,
        updatedAt: true,
        customDomain: { select: { domain: true, verifiedAt: true } },
      },
    });
    if (!tenant) throw new NotFoundException("Salon not found");

    const [services, professionals] = await Promise.all([
      this.prisma.service.findMany({
        where: { tenantId: tenant.id, isActive: true },
        select: {
          id: true,
          name: true,
          description: true,
          duration: true,
          price: true,
          currency: true,
          category: true,
        },
        orderBy: [{ category: "asc" }, { name: "asc" }],
      }),
      this.prisma.professional.findMany({
        where: { tenantId: tenant.id, isActive: true },
        select: {
          id: true,
          firstName: true,
          lastName: true,
          profileImage: true,
          bio: true,
          position: true,
          specialties: true,
          portfolioImages: true,
          yearsExperience: true,
          languages: true,
          certifications: true,
          workingHours: true,
          services: { select: { serviceId: true } },
        },
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      }),
    ]);

    const openingHours: Record<string, SalonDayWindow> = salonWeekFrom(professionals);

    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      description: tenant.description,
      logo: tenant.logo,
      coverImage: tenant.coverImage,
      website: tenant.website,
      email: tenant.email,
      phone: tenant.phone,
      address: {
        street: tenant.street,
        city: tenant.city,
        state: tenant.state,
        postalCode: tenant.postalCode,
        country: tenant.country,
      },
      currency: tenant.currency,
      timezone: tenant.timezone,
      language: tenant.language,
      updatedAt: tenant.updatedAt,
      services: services.map((s) => ({ ...s, price: Number(s.price) })),
      // workingHours is summarised into openingHours rather than exposed
      // per person.
      professionals: professionals.map(({ workingHours: _wh, ...p }) => p),
      openingHours,
      customDomain: this.liveDomain(tenant.customDomain),
      // salon-lucia.kiraroom.net, once subdomains serve over HTTPS.
      subdomainHost: this.webDomain.liveSubdomain(tenant.slug),
    };
  }

  /** Salons for the sitemap: slug, last change and live domain only. */
  async listForSitemap() {
    const rows = await this.prisma.tenant.findMany({
      where: {
        deletedAt: null,
        subscriptionStatus: { in: LISTED_STATUSES },
        // A page with nothing to book is thin content; leave it out.
        services: { some: { isActive: true } },
      },
      select: {
        slug: true,
        updatedAt: true,
        customDomain: { select: { domain: true, verifiedAt: true } },
      },
      orderBy: { updatedAt: "desc" },
      take: 50_000, // the sitemap protocol's limit per file
    });
    return rows.map((r) => ({
      slug: r.slug,
      updatedAt: r.updatedAt,
      customDomain: this.liveDomain(r.customDomain),
      subdomainHost: this.webDomain.liveSubdomain(r.slug),
    }));
  }

  /**
   * Which salon a verified custom domain belongs to. Called by the
   * frontend middleware for requests whose Host is not the platform's.
   */
  async resolveHost(rawHost: string) {
    const host = normalizeDomain(rawHost);
    if (!host) throw new NotFoundException("Domain not found");
    const row = await this.prisma.customDomain.findFirst({
      where: { domain: host, verifiedAt: { not: null }, tenant: { deletedAt: null } },
      select: { tenant: { select: { slug: true } } },
      orderBy: { verifiedAt: "desc" },
    });
    if (!row) throw new NotFoundException("Domain not found");
    return { slug: row.tenant.slug };
  }

  /** The domain to use as canonical, only once it actually serves the page. */
  private liveDomain(cd: { domain: string; verifiedAt: Date | null } | null): string | null {
    if (!cd || !cd.verifiedAt || !this.webDomain.servingEnabled()) return null;
    return cd.domain;
  }
}
