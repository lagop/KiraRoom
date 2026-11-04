import { GoneException, Injectable, NotFoundException, Optional } from "@nestjs/common";
import { Prisma, SubscriptionStatus } from "@prisma/client";
import { PrismaService } from "../common/prisma/prisma.service";
import { redirectedTenantId } from "../web-address/web-address.service";
import { salonOpenShifts, salonOpenWeek, SalonDayWindow } from "../appointments/working-hours";
import { normalizeDomain } from "../web-domain/custom-domain";
import { WebDomainService } from "../web-domain/web-domain.service";
import { MAX_SPAN_DAYS, dateOfDay, daysOf } from "../time-off/time-off-rules";
import { salonOffersWhatsAppPromotions, salonWhatsAppConnected } from "../consent/client-notices";
import { FeatureFlagService } from "../common/feature-flags/feature-flag.service";
import { publicPrice, publicPriceSettings } from "../common/public-price";
import { clientLocations, formatLocationAddress, professionalLocationsOf } from "../multi-location/client-locations";
import { publicPageGone } from "../common/guards/read-only-tenant.guard";
import { bookingUnavailableReason } from "./booking-availability";
import { imageVersion, parseImageDataUrl, portfolioIndex, publicImageUrl, type PublicImageKind } from "./public-images";
import { publicProfessionals, showsPhoto } from "./public-professional";

/** "+34 600 11 22 33" -> "34600112233" for a wa.me link; null when it is not a phone. */
export function whatsappDigits(raw: string | null | undefined): string | null {
  const digits = (raw ?? "").replace(/[^0-9]/g, "");
  if (digits.length < 9 || digits.length > 15) return null;
  // A Spanish number written without its prefix.
  return digits.length === 9 ? `34${digits}` : digits;
}

/** The salon's own privacy policy, only as an https URL. */
export function ownPrivacyPolicyUrl(raw: string | null | undefined): string | null {
  const v = raw?.trim();
  if (!v) return null;
  try {
    const url = new URL(v);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

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
    // The plan check for the WhatsApp promotions box (global FeatureFlagModule).
    @Optional() private readonly featureFlags?: FeatureFlagService,
  ) {}

  /**
   * D4: the salon by its address or id; an old address (changed in the last
   * 12 months) finds the salon too. The answer carries the current slug, so
   * the page and the middleware send a 301 to it.
   */
  private async findPublicTenant<S extends Prisma.TenantSelect>(
    slugOrId: string,
    select: S,
  ): Promise<Prisma.TenantGetPayload<{ select: S }> | null> {
    const found = await this.prisma.tenant.findFirst({
      where: { OR: [{ slug: slugOrId }, { id: slugOrId }], deletedAt: null },
      select,
    });
    if (found) return found as Prisma.TenantGetPayload<{ select: S }>;
    const movedTo = await redirectedTenantId(this.prisma, slugOrId);
    if (!movedTo) return null;
    return (await this.prisma.tenant.findFirst({ where: { id: movedTo, deletedAt: null }, select })) as Prisma.TenantGetPayload<{
      select: S;
    }> | null;
  }

  async getPage(slugOrId: string) {
    const tenant = await this.findPublicTenant(slugOrId, {
        id: true,
        name: true,
        slug: true,
        description: true,
        logo: true,
        coverImage: true,
        website: true,
        // Canonical profile URLs (common/social-links.ts), set in the
        // salon's general settings.
        instagram: true,
        facebook: true,
        email: true,
        phone: true,
        street: true,
        city: true,
        state: true,
        postalCode: true,
        country: true,
        timezone: true,
        language: true,
        // The salon's own words, shown next to its hours (informational).
        cancellationPolicy: true,
        // Without policy text, the page says how long before an online
        // cancellation is still possible (audit 7 N15).
        minCancelHours: true,
        // Read into openingHours/openingShifts below, never sent as stored.
        openingHours: true,
        // Read for the prices (common/public-price.ts), never sent.
        fiscalSettings: true,
        // Read for acceptsBookings below, never sent.
        subscriptionStatus: true,
        readOnlyUntil: true,
        // "Escríbenos por WhatsApp", as a wa.me link.
        whatsapp: true,
        privacyPolicyUrl: true,
        // Ajustes > Recepcionista "Chat en mi web": off, no chat on the page.
        webChatEnabled: true,
        updatedAt: true,
        customDomain: { select: { domain: true, verifiedAt: true } },
    });
    if (!tenant) throw new NotFoundException("Salon not found");
    // Past its read-only period (or cancelled with none): the page is gone,
    // 410 rather than 404, so search engines drop it for good.
    if (publicPageGone(tenant)) throw new GoneException("Salon page no longer available");

    const today = new Intl.DateTimeFormat("en-CA", { timeZone: tenant.timezone || "Europe/Madrid" }).format(
      new Date(),
    );
    const horizon = new Date(dateOfDay(today)!.getTime() + MAX_SPAN_DAYS * 86_400_000);
    const [services, professionals, closures, whatsappNotices, where, whatsappPromotions] = await Promise.all([
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
          // Shown on the price list, but booked by phone when false.
          isOnlineBookable: true,
          // How many days ahead it can be booked online (the booking window
          // the date picker stops at; GET /appointments/booking-window).
          maxAdvanceBooking: true,
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
          // "Mostrar en la web" and "Mostrar foto" (public-professional.ts).
          webNameDisplay: true,
          webShowPhoto: true,
          services: { select: { serviceId: true } },
        },
        orderBy: [{ firstName: "asc" }, { lastName: "asc" }],
      }),
      // Whole days the salon is closed, from today on. Only the dates: never
      // a closure's note, nor anything about a professional's time off.
      this.prisma.timeOff.findMany({
        where: {
          tenantId: tenant.id,
          professionalId: null,
          startTime: null,
          // Closures are always approved (a CHECK says so); said here too, as everywhere time off blocks.
          status: "approved",
          endDate: { gte: dateOfDay(today)! },
          startDate: { lte: horizon },
        },
        select: { professionalId: true, locationId: true, kind: true, startDate: true, endDate: true },
      }),
      salonWhatsAppConnected(this.prisma, tenant.id),
      // Two or more locations someone can be booked at: the client picks one
      // (multi-location/client-locations.ts). None for every other salon.
      // ...and only while it has the multi-location feature (Empresa).
      clientLocations(this.prisma as any, tenant.id, this.featureFlags),
      salonOffersWhatsAppPromotions(this.prisma, this.featureFlags, tenant.id),
    ]);
    const horizonDay = horizon.toISOString().slice(0, 10);
    const daysClosed = (rows: typeof closures) =>
      [...new Set(rows.flatMap((c) => daysOf(c).filter((day) => day >= today && day <= horizonDay)))].sort();
    // The whole salon's closures; a location's own (multi-local) close only
    // that location, for a client who picked it.
    const closedDays = daysClosed(closures.filter((c) => !c.locationId));
    const closedDaysByLocation: Record<string, string[]> = Object.fromEntries(
      where.locations.map((l) => [l.id, daysClosed(closures.filter((c) => !c.locationId || c.locationId === l.id))]),
    );

    // The salon's own hours when it set them, else derived from its
    // professionals' schedules as before. openingHours keeps one window per
    // day (earliest to latest) for pages and widgets built before split
    // shifts; openingShifts has the gaps, so a salon that closes for lunch
    // can say so.
    const openingHours: Record<string, SalonDayWindow> = salonOpenWeek(tenant.openingHours, professionals);
    const openingShifts: Record<string, SalonDayWindow[]> = salonOpenShifts(tenant.openingHours, professionals);
    const prices = publicPriceSettings(tenant.fiscalSettings);

    return {
      id: tenant.id,
      name: tenant.name,
      slug: tenant.slug,
      description: tenant.description,
      // URLs, never the stored data: URLs (public-images.ts): an http(s)
      // URL as stored, or the API path that serves the image.
      logoUrl: publicImageUrl(tenant.id, "logo", tenant.logo),
      coverImageUrl: publicImageUrl(tenant.id, "cover", tenant.coverImage),
      website: tenant.website,
      instagram: tenant.instagram,
      facebook: tenant.facebook,
      email: tenant.email,
      phone: tenant.phone,
      // Digits for https://wa.me/<digits>; null when unset.
      whatsapp: whatsappDigits(tenant.whatsapp),
      // The salon's own privacy policy, when it set one: the page, widget
      // and chat link to it instead of /sites/<slug>/privacidad.
      privacyPolicyUrl: ownPrivacyPolicyUrl(tenant.privacyPolicyUrl),
      webChatEnabled: tenant.webChatEnabled !== false,
      address: {
        street: tenant.street,
        city: tenant.city,
        state: tenant.state,
        postalCode: tenant.postalCode,
        country: tenant.country,
      },
      // Euros: the till, invoices, deposits and Stripe charge in euros, and
      // the Moneda setting is gone (a salon that picked another one had its
      // prices relabelled but still charged in euros).
      currency: "EUR",
      timezone: tenant.timezone,
      // Informational: nothing charges a fee or stops a cancellation.
      cancellationPolicy: tenant.cancellationPolicy?.trim() || null,
      // The "Cancelar mi cita" link's deadline (appointments.service), for
      // "Puedes cancelar online hasta N h antes" when there is no policy text.
      minCancelHours: tenant.minCancelHours,
      language: tenant.language,
      updatedAt: tenant.updatedAt,
      // False while the salon is read-only (trial ended, cancelled,
      // suspended): the booking would be refused at the end
      // (appointments.service), so the page shows the phone instead of the
      // form and asks search engines not to index it. The page itself stays.
      //
      // Also false while it has no active professional (a new salon between
      // its first service and its first professional): no slot can be booked
      // (getAvailableSlots), so the page says "todavía no acepta reservas
      // online" with its phone (audit 7 N11). bookingUnavailable says which.
      acceptsBookings: bookingUnavailableReason(tenant.subscriptionStatus, professionals.length) === null,
      bookingUnavailable: bookingUnavailableReason(tenant.subscriptionStatus, professionals.length),
      // The final price, tax included, whichever way the salon writes its
      // catalogue: 36.30 for a 30.00 net service at 21 % IVA.
      services: services.map((s) => ({ ...s, price: publicPrice(s.price, prices) })),
      // The tax those prices include (IVA, IGIC, IPSI), so the page can say
      // "IVA incluido" once, next to the price list.
      taxLabel: prices.taxLabel,
      // workingHours is summarised into openingHours rather than exposed
      // per person.
      //
      // With locations to pick from, each professional also says where they
      // work (locationIds) and their main one, so the page offers only who
      // works at the chosen location, or takes the location from them.
      //
      // Named, pictured or left out as each one's "Mostrar en la web" says
      // (public-professional.ts); `listed: false` ones are bookable but not
      // in the team list.
      professionals: publicProfessionals(professionals.map(({ workingHours: _wh, ...p }) => p)).map((p) =>
        where.locations.length > 0 ? { ...p, ...professionalLocationsOf(p.id, where.locations, where.links) } : p,
      ),
      // Empty unless the salon has two or more locations to book at. Only
      // what the client needs to choose one and find it.
      locations: where.locations.map((l) => ({
        id: l.id,
        name: l.name,
        slug: l.slug,
        address: formatLocationAddress(l),
        phone: l.phone,
      })),
      openingHours,
      openingShifts,
      // "YYYY-MM-DD" days the salon is closed all day (holidays, closures),
      // so the booking page can say so instead of "no times left".
      closedDays,
      // With locations to pick from: the days each one is closed all day,
      // the whole salon's closures included. Empty otherwise.
      closedDaysByLocation,
      customDomain: this.liveDomain(tenant.customDomain),
      // salon-lucia.kiraroom.net, once subdomains serve over HTTPS.
      subdomainHost: this.webDomain.liveSubdomain(tenant.slug),
      // The salon has its WhatsApp number connected: the booking form offers
      // "Recibir los avisos de mi cita por WhatsApp". Only a yes or no.
      whatsappNotices,
      // ...and its plan includes WhatsApp campaigns: the form offers the
      // optional "Quiero recibir promociones de <salón> por WhatsApp".
      whatsappPromotions,
    };
  }

  /**
   * The salon's logo or cover photo, for GET /public-site/image/:tenantId/:kind.
   * Null when the salon has none, stored a web URL (the page links to it
   * directly) or is deleted.
   */
  async image(tenantId: string, kind: PublicImageKind) {
    const tenant = await this.prisma.tenant.findFirst({
      where: { id: tenantId, deletedAt: null },
      // Only the one asked for: a cover can weigh more than a megabyte.
      select: { logo: kind === "logo", coverImage: kind === "cover" },
    });
    const stored = (kind === "logo" ? tenant?.logo : tenant?.coverImage)?.trim();
    const image = parseImageDataUrl(stored);
    if (!stored || !image) return null;
    return { ...image, version: imageVersion(stored) };
  }

  /**
   * A professional's photo or portfolio picture, for
   * GET /public-site/professional-image/:professionalId/:slot. Only while
   * she is active, in a salon that exists, and shown with her photo.
   */
  async professionalImage(professionalId: string, slot: string) {
    const index = slot === "photo" ? null : portfolioIndex(slot);
    if (slot !== "photo" && index === null) return null;
    const pro = await this.prisma.professional.findFirst({
      where: { id: professionalId, isActive: true, tenant: { deletedAt: null } },
      select: {
        profileImage: slot === "photo",
        portfolioImages: slot !== "photo",
        webNameDisplay: true,
        webShowPhoto: true,
      },
    });
    if (!pro || !showsPhoto(pro)) return null;
    const list = Array.isArray(pro.portfolioImages) ? pro.portfolioImages : [];
    const raw = slot === "photo" ? pro.profileImage : list[index as number];
    const stored = typeof raw === "string" ? raw.trim() : "";
    const image = parseImageDataUrl(stored);
    if (!stored || !image) return null;
    return { ...image, version: imageVersion(stored) };
  }

  /**
   * Who runs the salon, for its generated privacy page and aviso legal
   * (LSSI art. 10: the business name, NIF, address and a contact must be
   * public on its website). Only those fields.
   */
  async legal(slugOrId: string) {
    const tenant = await this.findPublicTenant(slugOrId, {
        name: true,
        slug: true,
        legalName: true,
        taxId: true,
        email: true,
        phone: true,
        street: true,
        city: true,
        state: true,
        postalCode: true,
        country: true,
        privacyPolicyUrl: true,
        subscriptionStatus: true,
        readOnlyUntil: true,
    });
    if (!tenant) throw new NotFoundException("Salon not found");
    if (publicPageGone(tenant)) throw new GoneException("Salon page no longer available");
    return {
      name: tenant.name,
      slug: tenant.slug,
      legalName: tenant.legalName?.trim() || null,
      taxId: tenant.taxId?.trim() || null,
      email: tenant.email,
      phone: tenant.phone,
      address: {
        street: tenant.street,
        city: tenant.city,
        state: tenant.state,
        postalCode: tenant.postalCode,
        country: tenant.country,
      },
      privacyPolicyUrl: ownPrivacyPolicyUrl(tenant.privacyPolicyUrl),
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
