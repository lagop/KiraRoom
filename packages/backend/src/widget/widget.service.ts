import { GoneException, Injectable, NotFoundException, Logger, Optional } from "@nestjs/common";
import { randomBytes } from "crypto";
import { PrismaService } from "../common/prisma/prisma.service";
import { salonOffersWhatsAppPromotions, salonWhatsAppConnected } from "../consent/client-notices";
import { FeatureFlagService } from "../common/feature-flags/feature-flag.service";
import { publicPrice, publicPriceSettings } from "../common/public-price";
import { frameAncestorOrigins } from "./frame-origins";
import { publicPageGone } from "../common/guards/read-only-tenant.guard";
import { bookingUnavailableReason } from "../public-site/booking-availability";
import { publicImageUrl } from "../public-site/public-images";
import { publicProfessionals } from "../public-site/public-professional";
import { ownPrivacyPolicyUrl } from "../public-site/public-site.service";
import {
  clientLocations,
  formatLocationAddress,
  professionalLocationsOf,
  type ClientLocation,
  type LocationLinkRow,
} from "../multi-location/client-locations";

/**
 * The widget's location step (multi-local), as the public booking page has
 * it (#216): the salon's locations to book at (clientLocations: open, with an
 * active professional, two or more) narrowed to those where one of the
 * professionals this widget offers works. Fewer than two left: no step.
 */
export function widgetLocations(
  where: { locations: ClientLocation[]; links: LocationLinkRow[] },
  widgetProfessionalIds: string[],
): { locations: ClientLocation[]; links: LocationLinkRow[] } {
  const offered = new Set(widgetProfessionalIds);
  const locations = where.locations.filter((l) => l.professionalIds.some((id) => offered.has(id)));
  if (locations.length < 2) return { locations: [], links: [] };
  const ids = new Set(locations.map((l) => l.id));
  return { locations, links: where.links.filter((l) => ids.has(l.locationId) && offered.has(l.professionalId)) };
}

/** "#1a2B3c": the only colour form the widget takes (CSS custom property). */
export const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

/**
 * What the widget's look may carry to the embed page: its main colour
 * (buttons, selected options), lower-cased, when it is a valid hex. Anything
 * else stored in the theme JSON is not served.
 */
export function widgetTheme(theme: unknown): { primaryColor: string | null } {
  const raw = theme && typeof theme === "object" ? (theme as Record<string, unknown>).primaryColor : undefined;
  return { primaryColor: typeof raw === "string" && HEX_COLOR.test(raw.trim()) ? raw.trim().toLowerCase() : null };
}

/** A widget token: not a secret (it sits in the salon's iframe), just unguessable. */
export function newWidgetToken(): string {
  return randomBytes(24).toString("base64url");
}

/**
 * When a salon is deleted (SaaS console): every widget it embedded stops
 * loading. The rows stay (appointments point at them as their source); only
 * the token is replaced, so every copy of the old snippet answers 404.
 * Takes the caller's transaction client.
 */
export async function invalidateTenantWidgets(
  db: { widgetInstance: Pick<PrismaService["widgetInstance"], "findMany" | "update"> },
  tenantId: string,
): Promise<number> {
  const widgets = await db.widgetInstance.findMany({ where: { tenantId }, select: { id: true } });
  for (const w of widgets) {
    await db.widgetInstance.update({ where: { id: w.id }, data: { token: newWidgetToken() } });
  }
  return widgets.length;
}

export interface CreateWidgetInstanceInput {
  name: string;
  allowedOrigins?: string[];
  services?: string[];
  professionals?: string[];
  theme?: Record<string, unknown>;
}

@Injectable()
export class WidgetService {
  private readonly logger = new Logger(WidgetService.name);

  constructor(
    private prisma: PrismaService,
    // The plan check for the WhatsApp promotions box (global FeatureFlagModule).
    @Optional() private featureFlags?: FeatureFlagService,
  ) {}

  /**
   * With the whole token: it is not a secret (it sits in the iframe on the
   * salon's own site), and the panel builds the embed code from it. It
   * used to come back cut to six characters, so every snippet 404ed.
   */
  async list(tenantId: string) {
    return this.prisma.widgetInstance.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
  }

  async create(tenantId: string, input: CreateWidgetInstanceInput) {
    const token = this.generateToken();
    const created = await this.prisma.widgetInstance.create({
      data: {
        tenantId,
        token,
        name: input.name,
        allowedOrigins: input.allowedOrigins ?? [],
        services: input.services ?? [],
        professionals: input.professionals ?? [],
        theme: (input.theme as any) ?? {},
      },
    });
    return created;
  }

  async update(
    tenantId: string,
    id: string,
    input: Partial<CreateWidgetInstanceInput>,
  ) {
    const existing = await this.prisma.widgetInstance.findFirst({
      where: { id, tenantId },
    });
    if (!existing) throw new NotFoundException("Widget instance not found");
    return this.prisma.widgetInstance.update({
      where: { id },
      data: {
        name: input.name ?? existing.name,
        allowedOrigins: input.allowedOrigins ?? existing.allowedOrigins,
        services: input.services ?? existing.services,
        professionals: input.professionals ?? existing.professionals,
        theme: (input.theme as any) ?? existing.theme,
      },
    });
  }

  async revoke(tenantId: string, id: string) {
    const existing = await this.prisma.widgetInstance.findFirst({
      where: { id, tenantId },
    });
    if (!existing) throw new NotFoundException("Widget instance not found");
    await this.prisma.widgetInstance.delete({ where: { id } });
    return { revoked: true };
  }

  /**
   * The sites allowed to frame the widget, for the embed page's
   * frame-ancestors header (frontend middleware). Only valid https origins
   * (frame-origins.ts); an empty list means any site. Does not count as a
   * use of the widget.
   */
  async frameAncestors(token: string): Promise<{ allowedOrigins: string[]; restricted: boolean }> {
    const widget = await this.prisma.widgetInstance.findUnique({
      where: { token },
      select: { allowedOrigins: true },
    });
    if (!widget) throw new NotFoundException("Invalid widget token");
    const stored = (widget.allowedOrigins ?? []) as string[];
    return { allowedOrigins: frameAncestorOrigins(stored), restricted: stored.length > 0 };
  }

  /**
   * The widget behind a token, while its salon exists. A deleted salon's
   * widget answers 404 like a revoked one: its page is gone, and the iframe
   * on its own site went on showing its prices and team (deleting a salon
   * also replaces its widgets' tokens, see invalidateForTenant).
   */
  async findByToken(token: string) {
    const widget = await this.prisma.widgetInstance.findUnique({
      where: { token },
      include: { tenant: { select: { id: true, deletedAt: true } } },
    });
    if (!widget) throw new NotFoundException("Invalid widget token");
    if (!widget.tenant || widget.tenant.deletedAt) throw new NotFoundException("Invalid widget token");
    await this.prisma.widgetInstance.update({
      where: { id: widget.id },
      data: { lastUsedAt: new Date() },
    });
    return widget;
  }

  async getPublicConfig(widgetId: string) {
    const widget = await this.prisma.widgetInstance.findUnique({
      where: { id: widgetId },
      // Only what the answer uses: the whole row carried the salon's keys
      // and settings into memory for nothing.
      include: {
        tenant: {
          select: {
            id: true,
            name: true,
            slug: true,
            logo: true,
            coverImage: true,
            city: true,
            country: true,
            phone: true,
            timezone: true,
            language: true,
            fiscalSettings: true,
            subscriptionStatus: true,
            readOnlyUntil: true,
            privacyPolicyUrl: true,
            deletedAt: true,
          },
        },
      },
    });
    if (!widget || !widget.tenant || widget.tenant.deletedAt) throw new NotFoundException("Widget not found");
    // Past its read-only period the salon's page answers 410, and so does
    // its widget: there is nothing to book and nobody to phone through it.
    if (publicPageGone(widget.tenant)) throw new GoneException("Este salón ya no reserva en KiraRoom");
    const allProfessionals = await this.prisma.professional.findMany({
      where: {
        tenantId: widget.tenantId,
        isActive: true,
        ...(widget.professionals.length > 0
          ? { id: { in: widget.professionals } }
          : {}),
      },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        bio: true,
        profileImage: true,
        specialties: true,
        // "Mostrar en la web" (public-professional.ts): her name as shown,
        // her photo only if shown, as on the salon's page.
        webNameDisplay: true,
        webShowPhoto: true,
        // Which services each one does, so the location step offers only
        // the services someone at the chosen location does.
        services: { select: { serviceId: true } },
      },
    });
    // Only what can be booked from here: a service the salon takes by phone
    // only (isOnlineBookable off) is refused at booking (bookOnline).
    const allServices = await this.prisma.service.findMany({
      where: {
        tenantId: widget.tenantId,
        isActive: true,
        isOnlineBookable: true,
        ...(widget.services.length > 0
          ? { id: { in: widget.services } }
          : {}),
      },
      select: {
        id: true,
        name: true,
        description: true,
        category: true,
        duration: true,
        price: true,
        currency: true,
        images: true,
      },
    });
    const prices = publicPriceSettings(widget.tenant.fiscalSettings);
    // Two or more locations to book at among this widget's professionals:
    // the client picks one, as on the public booking page. None otherwise.
    const where = widgetLocations(
      await clientLocations(this.prisma as any, widget.tenantId, this.featureFlags),
      allProfessionals.map((p) => p.id),
    );
    return {
      tenant: {
        id: widget.tenant.id,
        name: widget.tenant.name,
        slug: widget.tenant.slug,
        // URLs, never the stored data: URLs (public-site/public-images.ts).
        logoUrl: publicImageUrl(widget.tenant.id, "logo", widget.tenant.logo),
        coverImageUrl: publicImageUrl(widget.tenant.id, "cover", widget.tenant.coverImage),
        city: widget.tenant.city,
        country: widget.tenant.country,
        // Shown, with acceptsBookings false, instead of the booking steps.
        phone: widget.tenant.phone,
        timezone: widget.tenant.timezone,
        // Euros, as everything is charged (the Moneda setting is gone).
        currency: "EUR",
        language: widget.tenant.language,
        // The tax the prices below include (IVA, IGIC, IPSI): "IVA incluido".
        taxLabel: prices.taxLabel,
      },
      // False while the salon is read-only (trial ended, cancelled,
      // suspended), as on its public page: the booking would be refused at
      // the end, so the widget says to phone the salon instead.
      // Or while nobody on the widget is active: nothing to book (audit 7 N11).
      acceptsBookings: bookingUnavailableReason(widget.tenant.subscriptionStatus, allProfessionals.length) === null,
      bookingUnavailable: bookingUnavailableReason(widget.tenant.subscriptionStatus, allProfessionals.length),
      widget: {
        id: widget.id,
        name: widget.name,
        allowedOrigins: frameAncestorOrigins(widget.allowedOrigins),
        theme: widgetTheme(widget.theme),
      },
      // The salon's own privacy policy, when it set one (https); otherwise
      // the widget links to /sites/<slug>/privacidad.
      privacyPolicyUrl: ownPrivacyPolicyUrl(widget.tenant.privacyPolicyUrl),
      // The final price, tax included (common/public-price.ts), never the
      // net catalogue figure of a salon that writes its prices without it.
      services: allServices.map((s) => ({ ...s, price: publicPrice(s.price, prices) })),
      // With locations to pick from, each one also says where they work and
      // their main location (the location follows from who she picks).
      // Hidden ones stay bookable as "Profesional" (public-professional.ts).
      professionals: publicProfessionals(allProfessionals).map((p) =>
        where.locations.length > 0 ? { ...p, ...professionalLocationsOf(p.id, where.locations, where.links) } : p,
      ),
      // Empty unless there is a location to choose. Only what the client
      // needs to choose one and find it.
      locations: where.locations.map((l) => ({
        id: l.id,
        name: l.name,
        slug: l.slug,
        address: formatLocationAddress(l),
        phone: l.phone,
      })),
      // The salon has its WhatsApp number connected: the form offers
      // "Recibir los avisos de mi cita por WhatsApp".
      whatsappNotices: await salonWhatsAppConnected(this.prisma, widget.tenantId),
      // ...and its plan includes WhatsApp campaigns: the form offers the
      // optional "Quiero recibir promociones de <salón> por WhatsApp".
      whatsappPromotions: await salonOffersWhatsAppPromotions(this.prisma, this.featureFlags, widget.tenantId),
    };
  }

  async incrementBookCount(widgetInstanceId: string) {
    await this.prisma.widgetInstance.update({
      where: { id: widgetInstanceId },
      data: { bookCount: { increment: 1 } },
    });
  }

  private generateToken(): string {
    return newWidgetToken();
  }
}