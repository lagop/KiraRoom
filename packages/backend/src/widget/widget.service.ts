import { Injectable, NotFoundException, Logger } from "@nestjs/common";
import { randomBytes } from "crypto";
import { PrismaService } from "../common/prisma/prisma.service";

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

  constructor(private prisma: PrismaService) {}

  async list(tenantId: string) {
    const items = await this.prisma.widgetInstance.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
    });
    return items.map((w) => this.sanitize(w));
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
    const allServices = await this.prisma.service.findMany({
      where: {
        tenantId: widget.tenantId,
        isActive: true,
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
      },
      widget: {
        id: widget.id,
        name: widget.name,
        allowedOrigins: widget.allowedOrigins,
        theme: widget.theme,
      },
      services: allServices,
      professionals: allProfessionals,
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

  private sanitize<T extends { token?: string }>(w: T): T {
    const copy = { ...w } as any;
    copy.token = copy.token ? `${copy.token.slice(0, 6)}…` : null;
    return copy;
  }
}