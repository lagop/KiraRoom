import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { FeatureFlagService } from "../common/feature-flags/feature-flag.service";
import { buildConsolidatedReport, ConsolidatedReport } from "./consolidated-report";
import { CreateLocationDto, UpdateLocationDto } from "./location.dto";
import {
  AnalyticsAppointment,
  SalonPeriod,
  addDays,
  rangePeriod,
  salonToday,
  scheduledDateRange,
} from "../analytics/analytics-metrics";

@Injectable()
export class MultiLocationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly flags: FeatureFlagService,
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
    const loc = await this.get(tenantId, id);
    if (dto.isActive === false && loc.isActive) {
      await this.assertNotLastActive(tenantId);
    }
    return this.prisma.location.update({
      where: { id },
      data: { ...dto, slug: dto.slug ? this.slugify(dto.slug) : undefined },
    });
  }

  /**
   * The Empresa plan works from one location ("activable desde 1 local",
   * minLocations: 1 in the plan catalogue). This used to refuse to leave
   * fewer than 2 active locations -- a leftover of the rev3 rule -- so an
   * Empresa salon with two locations could not close one. The only real
   * limit is not switching off the last one.
   */
  private async assertNotLastActive(tenantId: string) {
    const activeCount = await this.prisma.location.count({
      where: { tenantId, isActive: true },
    });
    if (activeCount <= 1) {
      throw new BadRequestException(
        "No puedes desactivar tu único local activo. Crea o reactiva otro antes.",
      );
    }
  }

  async remove(tenantId: string, id: string) {
    const loc = await this.get(tenantId, id);
    if (loc.isActive) await this.assertNotLastActive(tenantId);
    return this.prisma.location.update({
      where: { id },
      data: { isActive: false },
    });
  }

  /**
   * Loads everything the report needs for `period` and builds it. `extra`
   * adds a location that is not active (the KPIs of a closed location) to
   * the rows.
   */
  private async buildReport(
    tenantId: string,
    period: SalonPeriod,
    extra?: { id: string; name: string },
  ): Promise<ConsolidatedReport> {
    const [active, appointments, professionals, links] = await Promise.all([
      this.prisma.location.findMany({
        where: { tenantId, isActive: true },
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true },
      }),
      this.prisma.appointment.findMany({
        where: { tenantId, scheduledDate: scheduledDateRange(period) },
        select: {
          status: true,
          paymentStatus: true,
          amountPaid: true,
          totalAmount: true,
          price: true,
          scheduledDate: true,
          duration: true,
          clientId: true,
          professionalId: true,
          serviceId: true,
          locationId: true,
          service: { select: { name: true } },
        },
      }),
      this.prisma.professional.findMany({
        where: { tenantId, isActive: true },
        select: { id: true, workingHours: true },
      }),
      this.prisma.professionalLocation.findMany({
        where: { location: { tenantId } },
        select: { professionalId: true, locationId: true, isPrimary: true },
      }),
    ]);
    const locations =
      extra && !active.some((l) => l.id === extra.id) ? [...active, extra] : active;
    return buildConsolidatedReport({
      period,
      locations,
      appointments: appointments as unknown as AnalyticsAppointment[],
      professionals,
      links,
    });
  }

  private async todayOf(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { timezone: true },
    });
    return salonToday(tenant?.timezone || "Europe/Madrid");
  }

  /** One location's KPIs over the last 30 salon days. Money in cents. */
  async getStats(tenantId: string, id: string) {
    const loc = await this.get(tenantId, id);
    const today = await this.todayOf(tenantId);
    const period = { start: addDays(today, -29), end: today };
    const report = await this.buildReport(tenantId, period, { id: loc.id, name: loc.name });
    const row = report.perLocation.find((r) => r.locationId === id)!;
    return {
      locationId: id,
      windowDays: 30,
      period,
      currencyUnit: "cents" as const,
      appointmentCount: row.appointments,
      revenue: row.revenue,
      occupancy: row.occupancy,
      activeProfessionals: row.professionals,
      totalClients: row.clients,
    };
  }

  /**
   * Revenue, appointments, occupancy and top services per active location
   * for a named range of the salon's calendar ("this_month", "last_month",
   * "last_30_days", "3_months"...). See consolidated-report.ts for how
   * appointments are attributed to locations.
   */
  async getConsolidated(tenantId: string, range?: string) {
    const enabled = await this.flags.isEnabled(
      tenantId,
      "consolidated_reports",
    );
    if (!enabled) {
      throw new ForbiddenException(
        "Los informes consolidados están disponibles solo en el plan Empresa.",
      );
    }
    const activeCount = await this.prisma.location.count({
      where: { tenantId, isActive: true },
    });
    if (activeCount === 0) {
      throw new BadRequestException(
        "No tienes locales activos. Crea uno en Multi-local para ver el informe.",
      );
    }
    const today = await this.todayOf(tenantId);
    const rangeKey = range || "this_month";
    const period = rangePeriod(rangeKey, today, 12);
    const report = await this.buildReport(tenantId, period);
    return { range: rangeKey, ...report };
  }
}
