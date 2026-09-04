import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { FeatureFlagService } from "../common/feature-flags/feature-flag.service";
import { SubscriptionsService } from "../payments/services/subscriptions.service";

export interface CreateLocationDto {
  name: string;
  slug?: string;
  street?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  country?: string;
  timezone?: string;
  phone?: string;
  email?: string;
}

export interface UpdateLocationDto extends Partial<CreateLocationDto> {
  isActive?: boolean;
}

@Injectable()
export class MultiLocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  private slugify(input: string): string {
    return (input || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/(^-|-$)/g, "")
      .slice(0, 64);
  }

  async list(tenantId: string) {
    return this.prisma.location.findMany({
      where: { tenantId },
      orderBy: { createdAt: "asc" },
      include: {
        _count: { select: { appointments: true, professionals: true } },
      },
    });
  }

  async get(tenantId: string, id: string) {
    const loc = await this.prisma.location.findFirst({
      where: { id, tenantId },
    });
    if (!loc) throw new NotFoundException("Local no encontrado");
    return loc;
  }

  async create(tenantId: string, dto: CreateLocationDto) {
    const enabled = await this.flags.isEnabled(tenantId, "multi_location");
    if (!enabled) {
      throw new ForbiddenException(
        "Multi-local está disponible solo en el plan Empresa.",
      );
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { maxLocations: true, plan: true },
    });
    if (!tenant) throw new NotFoundException("Tenant no encontrado");
    const current = await this.prisma.location.count({ where: { tenantId } });
    const max = tenant.maxLocations ?? 1;
    if (current >= max) {
      throw new BadRequestException(
        `Has alcanzado el maximo de locales (${max}) para tu plan Empresa.`,
      );
    }
    const slug = (dto.slug || this.slugify(dto.name)).toLowerCase();
    if (!slug) throw new BadRequestException("slug es obligatorio");
    const exists = await this.prisma.location.findUnique({
      where: { tenantId_slug: { tenantId, slug } },
    });
    if (exists) {
      throw new BadRequestException(`Ya existe un local con slug '${slug}'.`);
    }
    return this.prisma.location.create({
      data: {
        tenantId,
        name: dto.name,
        slug,
        street: dto.street,
        city: dto.city,
        state: dto.state,
        postalCode: dto.postalCode,
        country: dto.country || "ES",
        timezone: dto.timezone || "Europe/Madrid",
        phone: dto.phone,
        email: dto.email,
      },
    });
  }

  async update(tenantId: string, id: string, dto: UpdateLocationDto) {
    await this.get(tenantId, id);
    return this.prisma.location.update({
      where: { id },
      data: { ...dto, slug: dto.slug ? this.slugify(dto.slug) : undefined },
    });
  }

  async remove(tenantId: string, id: string) {
    const loc = await this.get(tenantId, id);
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { plan: true },
    });
    const activeCount = await this.prisma.location.count({
      where: { tenantId, isActive: true },
    });
    if (
      this.subscriptions.normalizePlan(tenant?.plan || "esencial") ===
        "empresa" &&
      loc.isActive &&
      activeCount <= 2
    ) {
      throw new BadRequestException(
        "El plan Empresa requiere al menos 2 locales activos. Cambia a Pro si quieres operar un solo local.",
      );
    }
    return this.prisma.location.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async getStats(tenantId: string, id: string) {
    await this.get(tenantId, id);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const [apptCount, revenue, pros, clients] = await Promise.all([
      this.prisma.appointment.count({
        where: { locationId: id, scheduledDate: { gte: since } },
      }),
      this.prisma.payment.aggregate({
        _sum: { amount: true },
        where: {
          tenantId,
          status: "paid",
          createdAt: { gte: since },
          appointment: { locationId: id },
        },
      }),
      this.prisma.professionalLocation.count({ where: { locationId: id } }),
      this.prisma.client.count({ where: { tenantId } }),
    ]);
    return {
      locationId: id,
      windowDays: 30,
      appointmentCount: apptCount,
      revenue: Number((revenue as any)._sum?.amount ?? 0),
      activeProfessionals: pros,
      totalClients: clients,
    };
  }

  async getConsolidated(tenantId: string) {
    const enabled = await this.flags.isEnabled(
      tenantId,
      "consolidated_reports",
    );
    if (!enabled) {
      throw new ForbiddenException(
        "Los informes consolidados están disponibles solo en el plan Empresa.",
      );
    }
    const activeLocations = await this.prisma.location.findMany({
      where: { tenantId, isActive: true },
      orderBy: { createdAt: "asc" },
    });
    if (activeLocations.length < 2) {
      throw new BadRequestException(
        "Necesitas al menos 2 locales activos para generar un informe consolidado.",
      );
    }
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const perLocation: Array<{
      locationId: string;
      name: string;
      appointmentCount: number;
      revenue: number;
    }> = [];
    let totalAppointments = 0;
    let totalRevenue = 0;
    for (const loc of activeLocations) {
      const [apptCount, revenueAgg] = await Promise.all([
        this.prisma.appointment.count({
          where: { locationId: loc.id, scheduledDate: { gte: since } },
        }),
        this.prisma.payment.aggregate({
          _sum: { amount: true },
          where: {
            tenantId,
            status: "paid",
            createdAt: { gte: since },
            appointment: { locationId: loc.id },
          },
        }),
      ]);
      const revenue = Number((revenueAgg as any)._sum?.amount ?? 0);
      totalAppointments += apptCount;
      totalRevenue += revenue;
      perLocation.push({
        locationId: loc.id,
        name: loc.name,
        appointmentCount: apptCount,
        revenue,
      });
    }
    return {
      windowDays: 30,
      activeLocations: activeLocations.length,
      totalAppointments,
      totalRevenue,
      perLocation,
    };
  }
}