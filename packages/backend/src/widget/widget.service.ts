import { Injectable, NotFoundException, Logger, Optional } from "@nestjs/common";
import { randomBytes } from "crypto";
import { PrismaService } from "../common/prisma/prisma.service";
import { salonOffersWhatsAppPromotions, salonWhatsAppConnected } from "../consent/client-notices";
import { FeatureFlagService } from "../common/feature-flags/feature-flag.service";
import { publicPrice, publicPriceSettings } from "../common/public-price";
import { frameAncestorOrigins } from "./frame-origins";

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

  async findByToken(token: string) {
    const widget = await this.prisma.widgetInstance.findUnique({
      where: { token },
      include: { tenant: true },
    });
    if (!widget) throw new NotFoundException("Invalid widget token");
    if (!widget.tenant) throw new NotFoundException("Tenant not found");
    await this.prisma.widgetInstance.update({
      where: { id: widget.id },
      data: { lastUsedAt: new Date() },
    });
    return widget;
  }

  async getPublicConfig(widgetId: string) {
    const widget = await this.prisma.widgetInstance.findUnique({
      where: { id: widgetId },
      include: { tenant: true },
    });
    if (!widget) throw new NotFoundException("Widget not found");
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
    return {
      tenant: {
        id: widget.tenant.id,
        name: widget.tenant.name,
        slug: widget.tenant.slug,
        logo: widget.tenant.logo,
        coverImage: widget.tenant.coverImage,
        city: widget.tenant.city,
        country: widget.tenant.country,
        timezone: widget.tenant.timezone,
        currency: widget.tenant.currency,
        language: widget.tenant.language,
        // The tax the prices below include (IVA, IGIC, IPSI): "IVA incluido".
        taxLabel: prices.taxLabel,
      },
      widget: {
        id: widget.id,
        name: widget.name,
        allowedOrigins: frameAncestorOrigins(widget.allowedOrigins),
        theme: widget.theme,
      },
      // The final price, tax included (common/public-price.ts), never the
      // net catalogue figure of a salon that writes its prices without it.
      services: allServices.map((s) => ({ ...s, price: publicPrice(s.price, prices) })),
      professionals: allProfessionals,
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
    return randomBytes(24).toString("base64url");
  }
}