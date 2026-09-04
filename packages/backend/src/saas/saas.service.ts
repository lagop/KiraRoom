import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "crypto";
import { PrismaService } from "../common/prisma/prisma.service";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { UpdateTenantDto } from "./dto/update-tenant.dto";
import { TenantFilterDto } from "./dto/tenant-filter.dto";
import { UserRole } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import {
  IMPERSONATION_TTL_SECONDS,
  IMPERSONATION_AUDIENCE,
  IMPERSONATION_DEFAULT_REASON,
  TENANT_ACTIVE_WHERE,
} from "./saas.constants";
import {
  assertTenantSlugAvailable,
  createTenantWithOwner,
  getActiveTenant,
  slugify,
} from "./saas.helpers";
import { AuditLogService } from "./audit-log.service";
import { SubscriptionsService } from "../payments/services/subscriptions.service";
import { normalizePlan, PLAN_PRICES, PlanId } from "@kira/shared";

export interface PaginatedResult<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

export interface SaasAnalytics {
  totalTenants: number;
  totalUsers: number;
  totalClients: number;
  totalAppointments: number;
  totalRevenue: number;
  mrr: number;
  newTenantsThisMonth: number;
  newUsersThisMonth: number;
  activeSubscriptions: number;
  trialTenants: number;
  churnedTenants: number;
  topCountries: { country: string; count: number }[];
  planDistribution: { plan: string; count: number }[];
}

@Injectable()
export class SaasService {
  private readonly logger = new Logger(SaasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly auditLog: AuditLogService,
    private readonly subscriptions: SubscriptionsService,
  ) {}

  async getAllTenants(filter: TenantFilterDto): Promise<PaginatedResult<any>> {
    const { page = 1, limit = 10, sortBy = "createdAt", sortOrder = "desc", search, plan, subscriptionStatus, country, createdAfter, createdBefore, includeDeleted } = filter;

    const where: any = {};

    if (!includeDeleted) {
      where.deletedAt = null;
    }

    if (search) {
      where.OR = [
        { name: { contains: search, mode: "insensitive" } },
        { slug: { contains: search, mode: "insensitive" } },
        { email: { contains: search, mode: "insensitive" } },
      ];
    }

    if (plan) {
      where.plan = plan;
    }

    if (subscriptionStatus) {
      where.subscriptionStatus = subscriptionStatus;
    }

    if (country) {
      where.country = country;
    }

    if (createdAfter) {
      where.createdAt = { ...where.createdAt, gte: new Date(createdAfter) };
    }

    if (createdBefore) {
      where.createdAt = { ...where.createdAt, lte: new Date(createdBefore) };
    }

    const [tenants, total] = await Promise.all([
      this.prisma.tenant.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        select: {
          id: true,
          name: true,
          slug: true,
          description: true,
          logo: true,
          website: true,
          email: true,
          phone: true,
          country: true,
          timezone: true,
          currency: true,
          plan: true,
          subscriptionStatus: true,
          currentPeriodStart: true,
          currentPeriodEnd: true,
          trialEnd: true,
          createdAt: true,
          _count: {
            select: {
              users: true,
              clients: true,
              appointments: true,
              professionals: true,
            },
          },
        },
      }),
      this.prisma.tenant.count({ where }),
    ]);

    return {
      data: tenants.map((tenant) => ({
        ...tenant,
        userCount: tenant._count.users,
        clientCount: tenant._count.clients,
        appointmentCount: tenant._count.appointments,
        professionalCount: tenant._count.professionals,
        _count: undefined,
      })),
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }

  async getTenantById(id: string) {
    // Use the helper so the soft-delete predicate is canonical. We need
    // the _count.include which the helper's Tenant shape doesn't carry,
    // so we re-fetch with the include after the existence check.
    await getActiveTenant(this.prisma, id);
    const tenant = await this.prisma.tenant.findFirst({
      where: { id, ...TENANT_ACTIVE_WHERE },
      include: {
        _count: {
          select: {
            users: true,
            clients: true,
            appointments: true,
            professionals: true,
            services: true,
            payments: true,
          },
        },
      },
    });

    if (!tenant) {
      throw new NotFoundException("Tenant not found");
    }

    return {
      ...tenant,
      userCount: tenant._count.users,
      clientCount: tenant._count.clients,
      appointmentCount: tenant._count.appointments,
      professionalCount: tenant._count.professionals,
      serviceCount: tenant._count.services,
      paymentCount: tenant._count.payments,
      _count: undefined,
    };
  }

  async createTenant(createTenantDto: CreateTenantDto) {
    const slug = createTenantDto.slug?.length
      ? slugify(createTenantDto.slug)
      : slugify(createTenantDto.name);

    await assertTenantSlugAvailable(this.prisma, slug);

    // A1.3: route through the shared helper so the trial defaults
    // (rev 3: 14-day Pro trial, "trialing" status, currentPeriodEnd =
    // trialEnd) stay in lockstep with auth.register and
    // invites.acceptWithSlug. The SaaS admin defaults the owner
    // password when one isn't supplied so the SaaS admin can mint
    // tenants and send a "set your password" magic link later.
    const { tenant } = await createTenantWithOwner(this.prisma, {
      name: createTenantDto.name,
      slug,
      description: createTenantDto.description,
      logo: createTenantDto.logo,
      coverImage: createTenantDto.coverImage,
      website: createTenantDto.website,
      email: createTenantDto.email,
      phone: createTenantDto.phone,
      whatsapp: createTenantDto.whatsapp,
      street: createTenantDto.street,
      city: createTenantDto.city,
      state: createTenantDto.state,
      postalCode: createTenantDto.postalCode,
      country: createTenantDto.country,
      timezone: createTenantDto.timezone,
      currency: createTenantDto.currency,
      language: createTenantDto.language,
      plan: normalizePlan(createTenantDto.plan),
      ownerEmail: createTenantDto.ownerEmail,
      ownerPassword: createTenantDto.ownerPassword || "ChangeMe123!",
      ownerFirstName: createTenantDto.ownerFirstName,
      ownerLastName: createTenantDto.ownerLastName,
    });

    return this.prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
  }

  async updateTenant(id: string, updateTenantDto: UpdateTenantDto) {
    const existing = await getActiveTenant(this.prisma, id);

    // P2A — Normalize NIF before persisting. Don't accept malformed
    // identifiers because AEAT / diputaciones reject them silently.
    const patch: any = { ...updateTenantDto };
    if (patch.taxId !== undefined) {
      const { validateNif } = await import("../common/validation/nif.validator");
      const v = validateNif(patch.taxId);
      if (!v.valid) {
        throw new BadRequestException(
          `taxId invalid (${v.error}): expected NIF/CIF/NIE in canonical form`,
        );
      }
      patch.taxId = v.normalized;
    }

    // P2A — Audit log on taxId change. Persistence + observability so
    // SaaS can trace who changed the emitter NIF and when — required for
    // financial-compliance audits.
    if (
      patch.taxId !== undefined &&
      patch.taxId !== existing.taxId
    ) {
      const before = existing.taxId ?? null;
      const after = patch.taxId;
      // Persist to the audit trail.
      try {
        await this.auditLog.record("tenant.taxId.change", {
          actorId: "saas:system",
          actorRole: "saas_owner" as any,
          tenantId: id,
          metadata: { before, after } as any,
        });
      } catch {
        // Audit failure shouldn't break the update — keep the change
        // committed; the audit row can be backfilled by an hourly job.
      }
      this.logger.warn(
        `tenant.taxId.change actor=SaaS tenantId=${id} before=${before} after=${after}`,
      );
    }

    return this.prisma.tenant.update({
      where: { id },
      data: patch,
    });
  }

  async deleteTenant(id: string, saasOwnerId: string) {
    await getActiveTenant(this.prisma, id);

    const deletedAt = new Date();

    // Best-effort Stripe cancellation. Done BEFORE the local soft-delete
    // so that a transient Stripe failure doesn't strand the tenant
    // in a deleted state with an active subscription. If Stripe is
    // unreachable, log and proceed — the local cancellation is the
    // source of truth for SaaS-side visibility, and the daily cron /
    // reconciliation job will sync Stripe later.
    try {
      await this.subscriptions.cancelSubscription(id, /* immediately */ false);
    } catch (err) {
      this.logger.warn(
        `Stripe cancel failed during soft-delete of tenant ${id}; continuing with local soft-delete.`,
        err instanceof Error ? err.stack : String(err),
      );
    }

    // Soft delete + audit must be atomic: the audit_logs.actorId FK
    // requires a real User id; using a literal like "system" would
    // throw P2003. We pass the calling SaaS owner's id from the
    // controller (req.user.id) and write both rows in one transaction
    // via the callback form so we can call AuditLogService.record()
    // with the same transaction client.
    const auditRow = await this.prisma.$transaction(async (tx) => {
      await tx.tenant.update({
        where: { id },
        data: { deletedAt },
        select: { id: true },
      });
      return this.auditLog.record(
        "tenant.soft_delete",
        {
          actorId: saasOwnerId,
          actorRole: UserRole.saas_owner,
          tenantId: id,
          metadata: { deletedAt: deletedAt.toISOString() },
        },
        tx,
      );
    });

    return {
      message: "Tenant soft-deleted successfully",
      deletedAt,
      auditLogId: auditRow.id,
    };
  }

  async suspendTenant(id: string) {
    const tenant = await getActiveTenant(this.prisma, id);

    return this.prisma.tenant.update({
      where: { id },
      data: {
        subscriptionStatus: "cancelled",
      },
    });
  }

  async reactivateTenant(id: string) {
    const tenant = await getActiveTenant(this.prisma, id);

    return this.prisma.tenant.update({
      where: { id },
      data: {
        subscriptionStatus: "active",
      },
    });
  }

  async getTenantStats(id: string) {
    const tenant = await getActiveTenant(this.prisma, id);

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);

    const [
      totalClients,
      totalAppointments,
      totalRevenue,
      appointmentsThisMonth,
      appointmentsLastMonth,
      revenueThisMonth,
      revenueLastMonth,
    ] = await Promise.all([
      this.prisma.client.count({ where: { tenantId: id } }),
      this.prisma.appointment.count({ where: { tenantId: id } }),
      this.prisma.appointment.aggregate({
        where: { tenantId: id, paymentStatus: "paid" },
        _sum: { price: true },
      }),
      this.prisma.appointment.count({
        where: { tenantId: id, createdAt: { gte: startOfMonth } },
      }),
      this.prisma.appointment.count({
        where: {
          tenantId: id,
          createdAt: { gte: startOfLastMonth, lte: endOfLastMonth },
        },
      }),
      this.prisma.appointment.aggregate({
        where: {
          tenantId: id,
          paymentStatus: "paid",
          createdAt: { gte: startOfMonth },
        },
        _sum: { price: true },
      }),
      this.prisma.appointment.aggregate({
        where: {
          tenantId: id,
          paymentStatus: "paid",
          createdAt: { gte: startOfLastMonth, lte: endOfLastMonth },
        },
        _sum: { price: true },
      }),
    ]);

    const appointmentsChange = appointmentsLastMonth > 0
      ? ((appointmentsThisMonth - appointmentsLastMonth) / appointmentsLastMonth) * 100
      : 0;

    const revenueLastMonthVal = Number(revenueLastMonth._sum.price) || 0;
    const revenueThisMonthVal = Number(revenueThisMonth._sum.price) || 0;
    const revenueChange = revenueLastMonthVal > 0
      ? ((revenueThisMonthVal - revenueLastMonthVal) / revenueLastMonthVal) * 100
      : 0;

    return {
      tenantId: id,
      tenantName: tenant.name,
      plan: tenant.plan,
      subscriptionStatus: tenant.subscriptionStatus,
      totalClients,
      totalAppointments,
      totalRevenue: Number(totalRevenue._sum.price) || 0,
      appointmentsThisMonth,
      appointmentsLastMonth,
      appointmentsChange: Math.round(appointmentsChange * 100) / 100,
      revenueThisMonth: revenueThisMonthVal,
      revenueLastMonth: revenueLastMonthVal,
      revenueChange: Math.round(revenueChange * 100) / 100,
    };
  }

  /**
   * Per-tenant onboarding progress score (Sprint 2 / 2.1, Workstream 2.1).
   *
   * Formula: `(servicesConfigured + workingHoursSet + staffAdded +
   * firstAppointmentCreated) / 4`. Each component is 1 if the tenant
   * has met the criterion, 0 otherwise.
   *
   * Surfaced on the SaaS admin dashboard so the founder can spot
   * tenants who have signed up but never finished onboarding.
   */
  async getTenantProgress(id: string) {
    const tenant = await getActiveTenant(this.prisma, id);

    const [servicesCount, professionalsCount, appointmentsCount] =
      await Promise.all([
        this.prisma.service.count({ where: { tenantId: id } }),
        this.prisma.professional.count({ where: { tenantId: id } }),
        this.prisma.appointment.count({ where: { tenantId: id } }),
      ]);

    const workingHoursSet =
      tenant.openingHours &&
      typeof tenant.openingHours === "object" &&
      Object.keys(tenant.openingHours as object).length > 0;

    const servicesConfigured = servicesCount > 0 ? 1 : 0;
    const staffAdded = professionalsCount > 0 ? 1 : 0;
    const firstAppointmentCreated = appointmentsCount > 0 ? 1 : 0;
    const workingHours = workingHoursSet ? 1 : 0;

    const completed = servicesConfigured + workingHours + staffAdded + firstAppointmentCreated;
    const score = completed / 4;

    return {
      tenantId: id,
      tenantName: tenant.name,
      score,
      percent: Math.round(score * 100),
      components: {
        servicesConfigured: Boolean(servicesConfigured),
        workingHoursSet: Boolean(workingHours),
        staffAdded: Boolean(staffAdded),
        firstAppointmentCreated: Boolean(firstAppointmentCreated),
      },
      counts: {
        services: servicesCount,
        professionals: professionalsCount,
        appointments: appointmentsCount,
      },
    };
  }

  async getPlatformAnalytics(): Promise<SaasAnalytics> {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    // Single Promise.all with the previously-trailing "this month"
    // counts folded in. The subscription-status breakdown uses one
    // groupBy instead of three separate count() calls.
    const [
      tenants,
      users,
      clients,
      appointments,
      totalRevenue,
      activePlanBreakdown,
      subscriptionStatusBreakdown,
      countryAggregation,
      planAggregation,
      newTenantsThisMonth,
      newUsersThisMonth,
    ] = await Promise.all([
      this.prisma.tenant.count({ where: { ...TENANT_ACTIVE_WHERE } }),
      this.prisma.user.count(),
      this.prisma.client.count(),
      this.prisma.appointment.count(),
      this.prisma.appointment.aggregate({
        where: { paymentStatus: "paid" },
        _sum: { price: true },
      }),
      // Per-plan counts of *active* (non-trialing, non-cancelled) tenants
      // are used to derive MRR. Trialing tenants contribute 0; cancelled
      // and past-due are excluded from MRR.
      this.prisma.tenant.groupBy({
        by: ["plan"],
        where: { subscriptionStatus: "active", ...TENANT_ACTIVE_WHERE },
        _count: true,
      }),
      this.prisma.tenant.groupBy({
        by: ["subscriptionStatus"],
        where: { ...TENANT_ACTIVE_WHERE },
        _count: true,
      }),
      this.prisma.tenant.groupBy({
        by: ["country"],
        where: { ...TENANT_ACTIVE_WHERE },
        _count: true,
        orderBy: { _count: { country: "desc" } },
        take: 5,
      }),
      this.prisma.tenant.groupBy({
        by: ["plan"],
        where: { ...TENANT_ACTIVE_WHERE },
        _count: true,
        orderBy: { _count: { plan: "desc" } },
      }),
      this.prisma.tenant.count({
        where: { createdAt: { gte: startOfMonth }, ...TENANT_ACTIVE_WHERE },
      }),
      this.prisma.user.count({
        where: { createdAt: { gte: startOfMonth } },
      }),
    ]);

    // Derive the three subscription counters from the single groupBy.
    // Unknown statuses (e.g. "past_due") are not surfaced today but the
    // zero-default keeps the API stable if a new enum value lands.
    const statusCount = (s: string) =>
      subscriptionStatusBreakdown.find((r) => r.subscriptionStatus === s)?._count ?? 0;

    // Real MRR: Σ (active tenants on plan P) × PLAN_PRICES[P].
    // Unknown plans contribute 0 so a new plan enum value doesn't crash analytics.
    const mrr = activePlanBreakdown.reduce((sum, row) => {
      const price = PLAN_PRICES[row.plan as keyof typeof PLAN_PRICES] ?? 0;
      return sum + row._count * price;
    }, 0);

    return {
      totalTenants: tenants,
      totalUsers: users,
      totalClients: clients,
      totalAppointments: appointments,
      totalRevenue: Number(totalRevenue._sum.price) || 0,
      mrr,
      newTenantsThisMonth,
      newUsersThisMonth,
      activeSubscriptions: statusCount("active"),
      trialTenants: statusCount("trialing"),
      churnedTenants: statusCount("cancelled"),
      topCountries: countryAggregation.map((c) => ({
        country: c.country,
        count: c._count,
      })),
      planDistribution: planAggregation.map((p) => ({
        plan: p.plan,
        count: p._count,
      })),
    };
  }

  async getAllUsers(filter: TenantFilterDto) {
    const { page = 1, limit = 10, sortBy = "createdAt", sortOrder = "desc", search, tenantId } = filter;

    const where: any = {};

    if (search) {
      where.OR = [
        { email: { contains: search, mode: "insensitive" } },
        { firstName: { contains: search, mode: "insensitive" } },
        { lastName: { contains: search, mode: "insensitive" } },
      ];
    }

    if (tenantId) {
      where.tenantId = tenantId;
    }

    const [users, total] = await Promise.all([
      this.prisma.user.findMany({
        where,
        skip: (page - 1) * limit,
        take: limit,
        orderBy: { [sortBy]: sortOrder },
        include: {
          tenant: {
            select: {
              id: true,
              name: true,
              slug: true,
            },
          },
        },
      }),
      this.prisma.user.count({ where }),
    ]);

    return {
      data: users,
      meta: {
        total,
        page,
        limit,
        totalPages: Math.ceil(total / limit),
      },
    };
  }
  async launchSalonDashboard(tenantId: string, saasOwnerId: string) {
    const tenant = await getActiveTenant(this.prisma, tenantId);

    // The Tenant model has no owner relation. Look up the owner User
    // by role; this matches the SaaS owner flow where each tenant has
    // exactly one user with role='owner'.
    const owner = await this.prisma.user.findFirst({
      where: { tenantId, role: "owner" },
      select: { id: true, email: true, firstName: true, lastName: true },
    });

    if (!owner) {
      throw new Error("Tenant has no owner assigned");
    }

    // Issue a short-lived (60 s) impersonation token. The actual session
    // for the tenant owner is minted by POST /auth/impersonate which
    // validates this token, atomically records the `jti` in
    // `used_impersonation_tokens` (one-shot), and writes an AuditLog row.
    const jti = randomUUID();
    const token = this.jwtService.sign(
      {
        sub: saasOwnerId,
        jti,
        impersonate: { tenantId, ownerId: owner.id },
        aud: IMPERSONATION_AUDIENCE,
      },
      { expiresIn: IMPERSONATION_TTL_SECONDS },
    );

    return {
      token,
      ownerEmail: owner.email,
      ownerName: `${owner.firstName} ${owner.lastName}`,
      tenantId: tenant.id,
      tenantName: tenant.name,
      tenantSlug: tenant.slug,
    };
  }

  async getSalonGrowthMetrics(tenantId: string, months: number = 6) {
    const now = new Date();
    const monthsData: { month: string; start: Date; end: Date }[] = [];

    for (let i = months - 1; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const monthStr = start.toISOString().slice(0, 7);
      monthsData.push({ month: monthStr, start, end });
    }

    const revenueEvolution: { month: string; value: number }[] = [];
    const appointmentsEvolution: { month: string; value: number }[] = [];
    const clientsEvolution: { month: string; value: number; newClients: number; returningClients: number }[] = [];

    for (const { month, start, end } of monthsData) {
      const [revenueResult, appointmentsResult, newClientsCount, totalClientsAtEnd] = await Promise.all([
        this.prisma.appointment.aggregate({
          where: {
            tenantId,
            paymentStatus: "paid",
            createdAt: { gte: start, lte: end },
          },
          _sum: { price: true },
        }),
        this.prisma.appointment.count({
          where: {
            tenantId,
            createdAt: { gte: start, lte: end },
          },
        }),
        this.prisma.client.count({
          where: {
            tenantId,
            createdAt: { gte: start, lte: end },
          },
        }),
        this.prisma.client.count({
          where: {
            tenantId,
            createdAt: { lte: end },
          },
        }),
      ]);

      revenueEvolution.push({
        month,
        value: Number(revenueResult._sum.price) || 0,
      });

      appointmentsEvolution.push({
        month,
        value: appointmentsResult,
      });

      clientsEvolution.push({
        month,
        value: totalClientsAtEnd,
        newClients: newClientsCount,
        returningClients: totalClientsAtEnd - newClientsCount,
      });
    }

    // Summary numbers come straight from the last two entries of the
    // evolution arrays — no extra Promise.all that re-runs the same
    // queries for the most recent two months. (Rev: previous
    // implementation duplicated 6 aggregations here.)
    const last = revenueEvolution[revenueEvolution.length - 1];
    const prev = revenueEvolution[revenueEvolution.length - 2];
    const appointmentsLast = appointmentsEvolution[appointmentsEvolution.length - 1];
    const appointmentsPrev = appointmentsEvolution[appointmentsEvolution.length - 2];
    const clientsLast = clientsEvolution[clientsEvolution.length - 1];
    const clientsPrev = clientsEvolution[clientsEvolution.length - 2];

    const revenueThisMonthVal = last?.value ?? 0;
    const revenueLastMonthVal = prev?.value ?? 0;
    const revenueChangePercent = revenueLastMonthVal > 0
      ? ((revenueThisMonthVal - revenueLastMonthVal) / revenueLastMonthVal) * 100
      : 0;

    const appointmentsThisMonth = appointmentsLast?.value ?? 0;
    const appointmentsLastMonth = appointmentsPrev?.value ?? 0;
    const appointmentsChangePercent = appointmentsLastMonth > 0
      ? ((appointmentsThisMonth - appointmentsLastMonth) / appointmentsLastMonth) * 100
      : 0;

    const newClientsThisMonth = clientsLast?.newClients ?? 0;
    const newClientsLastMonth = clientsPrev?.newClients ?? 0;
    const newClientsChangePercent = newClientsLastMonth > 0
      ? ((newClientsThisMonth - newClientsLastMonth) / newClientsLastMonth) * 100
      : 0;

    return {
      salonId: tenantId,
      period: `${months}_months`,
      revenueEvolution,
      appointmentsEvolution,
      clientsEvolution,
      summary: {
        revenueThisMonth: revenueThisMonthVal,
        revenueLastMonth: revenueLastMonthVal,
        revenueChangePercent: Math.round(revenueChangePercent * 100) / 100,
        appointmentsThisMonth,
        appointmentsLastMonth,
        appointmentsChangePercent: Math.round(appointmentsChangePercent * 100) / 100,
        newClientsThisMonth,
        newClientsLastMonth,
        newClientsChangePercent: Math.round(newClientsChangePercent * 100) / 100,
      },
    };
  }

  async getPlatformGrowthMetrics(months: number = 6) {
    const now = new Date();
    const monthsData: { month: string; start: Date; end: Date }[] = [];

    for (let i = months - 1; i >= 0; i--) {
      const start = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const end = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
      const monthStr = start.toISOString().slice(0, 7);
      monthsData.push({ month: monthStr, start, end });
    }

    const salonsEvolution: { month: string; total: number; new: number }[] = [];
    const revenueEvolution: { month: string; value: number }[] = [];
    const usersEvolution: { month: string; total: number; new: number }[] = [];
    const appointmentsEvolution: { month: string; value: number }[] = [];

    for (const { month, start, end } of monthsData) {
      const [totalSalons, newSalonsThisMonth, revenueResult, totalUsers, newUsersThisMonth, appointmentsCount] = await Promise.all([
        this.prisma.tenant.count({ where: { createdAt: { lte: end } } }),
        this.prisma.tenant.count({ where: { createdAt: { gte: start, lte: end } } }),
        this.prisma.appointment.aggregate({
          where: {
            paymentStatus: "paid",
            createdAt: { gte: start, lte: end },
          },
          _sum: { price: true },
        }),
        this.prisma.user.count({ where: { createdAt: { lte: end } } }),
        this.prisma.user.count({ where: { createdAt: { gte: start, lte: end } } }),
        this.prisma.appointment.count({
          where: { createdAt: { gte: start, lte: end } },
        }),
      ]);

      salonsEvolution.push({ month, total: totalSalons, new: newSalonsThisMonth });
      revenueEvolution.push({ month, value: Number(revenueResult._sum.price) || 0 });
      usersEvolution.push({ month, total: totalUsers, new: newUsersThisMonth });
      appointmentsEvolution.push({ month, value: appointmentsCount });
    }

    // Summary numbers come straight from the last two entries of the
    // evolution arrays. (Rev: previous implementation re-ran a 5-query
    // Promise.all + 1 extra count for totalSalonsNow — all of those
    // values are already in the loop results.) One outstanding query
    // is the cancelled count for churn rate, which the loop didn't
    // compute and which we run in parallel with totalSalonsNow.
    const revenueLast = revenueEvolution[revenueEvolution.length - 1];
    const revenuePrev = revenueEvolution[revenueEvolution.length - 2];
    const salonsLast = salonsEvolution[salonsEvolution.length - 1];
    const salonsPrev = salonsEvolution[salonsEvolution.length - 2];
    const thisMonth = monthsData[monthsData.length - 1];

    const [totalSalonsNow, cancelledThisMonth] = await Promise.all([
      this.prisma.tenant.count({ where: { ...TENANT_ACTIVE_WHERE } }),
      this.prisma.tenant.count({
        where: {
          subscriptionStatus: "cancelled",
          updatedAt: { gte: thisMonth.start, lte: thisMonth.end },
        },
      }),
    ]);

    const revenueThisMonth = revenueLast?.value ?? 0;
    const revenueLastMonth = revenuePrev?.value ?? 0;
    const revenueChangePercent = revenueLastMonth > 0
      ? ((revenueThisMonth - revenueLastMonth) / revenueLastMonth) * 100
      : 0;

    const newSalonsThisMonth = salonsLast?.new ?? 0;
    const newSalonsLastMonth = salonsPrev?.new ?? 0;
    const salonsGrowthPercent = newSalonsLastMonth > 0
      ? ((newSalonsThisMonth - newSalonsLastMonth) / newSalonsLastMonth) * 100
      : 0;
    const churnRate = totalSalonsNow > 0 ? (cancelledThisMonth / totalSalonsNow) * 100 : 0;

    return {
      period: `${months}_months`,
      salonsEvolution,
      revenueEvolution,
      usersEvolution,
      appointmentsEvolution,
      summary: {
        totalRevenueThisMonth: revenueThisMonth,
        totalRevenueLastMonth: revenueLastMonth,
        revenueChangePercent: Math.round(revenueChangePercent * 100) / 100,
        totalNewSalonsThisMonth: newSalonsThisMonth,
        totalNewSalonsLastMonth: newSalonsLastMonth,
        salonsGrowthPercent: Math.round(salonsGrowthPercent * 100) / 100,
        churnRate: Math.round(churnRate * 100) / 100,
      },
    };
  }
}
