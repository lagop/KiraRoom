import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  Logger,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomUUID } from "crypto";
import { PrismaService } from "../common/prisma/prisma.service";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { UpdateTenantDto } from "./dto/update-tenant.dto";
import { TenantFilterDto } from "./dto/tenant-filter.dto";
import { Prisma, UserRole } from "@prisma/client";
import type { Tenant } from "@prisma/client";
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
import { loadSharedIdentityWarnings, type SharedIdentityWarning } from "./shared-identity";
import { invalidateTenantWidgets } from "../widget/widget.service";
import { SubscriptionsService } from "../payments/services/subscriptions.service";
import { normalizePlan, PLAN_PRICES } from "@kira/shared";
import { isReadOnlyStatus } from "../common/guards/read-only-tenant.guard";
import { normalizeWebAddress, WEB_ADDRESS_MESSAGES } from "../web-address/web-address-rules";
import { DAY_MS, READ_ONLY_DAYS } from "./retention/salon-retention";
import {
  CONSOLE_EDIT_MESSAGES,
  CONSOLE_TENANT_SELECT,
  STALE_RETENTION_RESET,
  consoleSlugProblem,
  consoleTenantView,
  pendingDeletionMessage,
  rethrowUniqueConflict,
  retentionView,
} from "./console-tenant";

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
      const term = { contains: search, mode: "insensitive" } as const;
      where.OR = [
        { name: term },
        { slug: term },
        { email: term },
        { phone: term },
        // A salon from the normal signup has no salon email: the owner
        // writes from her own (audit 8 T17).
        { users: { some: { role: UserRole.owner, OR: [{ email: term }, { firstName: term }, { lastName: term }] } } },
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
          // "Mostrar eliminados" marks them, and their actions are hidden (T9).
          deletedAt: true,
          anonymizedAt: true,
          deletionRequestedAt: true,
          users: {
            where: { role: UserRole.owner },
            select: { email: true, firstName: true, lastName: true },
            orderBy: { createdAt: "asc" },
            take: 1,
          },
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

    const shared = await this.sharedIdentity(tenants.map((t) => t.id));
    return {
      data: tenants.map(({ users, ...tenant }) => ({
        ...tenant,
        owner: users?.[0] ?? null,
        // Another salon has the same phone or NIF (D9): shown, never blocked.
        sharedIdentity: shared.get(tenant.id) ?? [],
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

  /** Shared phone / NIF warnings (D9); an error here never breaks the console. */
  private async sharedIdentity(ids: string[]): Promise<Map<string, SharedIdentityWarning[]>> {
    try {
      return await loadSharedIdentityWarnings(this.prisma, ids);
    } catch (err) {
      this.logger.warn(`Shared identity check failed: ${(err as Error).message}`);
      return new Map();
    }
  }

  /**
   * The salon's console page. Explicit columns (audit 8 T24): never its
   * Stripe secret keys, channel credentials (features), fiscal or
   * accounting settings or deletionRestore. A deleted salon opens too, read
   * only, with its deletion and anonymisation dates (T9).
   */
  async getTenantById(id: string) {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id },
      select: {
        ...CONSOLE_TENANT_SELECT,
        users: {
          where: { role: UserRole.owner },
          select: { id: true, email: true, firstName: true, lastName: true, phone: true, lastLoginAt: true },
          orderBy: { createdAt: "asc" },
          take: 1,
        },
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
      throw new NotFoundException("Salón no encontrado");
    }

    const { users, _count, ...rest } = tenant;
    const shared = await this.sharedIdentity([tenant.id]);
    return {
      ...consoleTenantView(rest),
      owner: users?.[0] ?? null,
      retention: retentionView(rest),
      sharedIdentity: shared.get(tenant.id) ?? [],
      userCount: _count.users,
      clientCount: _count.clients,
      appointmentCount: _count.appointments,
      professionalCount: _count.professionals,
      serviceCount: _count.services,
      paymentCount: _count.payments,
    };
  }

  async createTenant(createTenantDto: CreateTenantDto) {
    // At least 3 characters, letters without accents, digits and hyphens:
    // the form used to keep only the first letter typed ("s") and the API
    // took it (audit 8 T7). The reserved names stay as they were.
    const slug = createTenantDto.slug?.trim().length
      ? normalizeWebAddress(createTenantDto.slug)
      : slugify(createTenantDto.name);
    const shape = consoleSlugProblem(slug);
    if (shape) throw new BadRequestException(WEB_ADDRESS_MESSAGES[shape]);

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
    }).catch(rethrowUniqueConflict);

    return this.getTenantById(tenant.id);
  }

  /**
   * The console's edit form (audit 8 T13, T22). The plan and the status are
   * checked against each other and against Stripe:
   * - "Pago pendiente" and "Suspendido por impago" are Stripe's to set;
   * - "En prueba" needs a trial end in the future (a new one extends it);
   * - the plan of a salon that pays in Stripe changes in Stripe;
   * - "De baja" on a salon Stripe still charges is refused.
   * Leaving read-only clears the old retention dates, and a pending "Borrar
   * mi salón" is not dropped silently (T4): see leaveReadOnly().
   */
  async updateTenant(id: string, updateTenantDto: UpdateTenantDto, actorId?: string) {
    const existing = await getActiveTenant(this.prisma, id);
    const now = new Date();

    // P2A — Normalize NIF before persisting. Don't accept malformed
    // identifiers because AEAT / diputaciones reject them silently.
    const { cancelDeletion, ...fields } = updateTenantDto;
    const patch: any = { ...fields };
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

    Object.assign(patch, this.subscriptionPatch(existing, patch, now));
    if (isReadOnlyStatus(existing.subscriptionStatus) && !isReadOnlyStatus(patch.subscriptionStatus ?? existing.subscriptionStatus)) {
      Object.assign(patch, await this.leaveReadOnly(existing, !!cancelDeletion, actorId));
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

    const updated = await this.prisma.tenant
      .update({
        where: { id },
        data: patch,
        select: CONSOLE_TENANT_SELECT,
      })
      .catch(rethrowUniqueConflict);
    return consoleTenantView(updated);
  }

  /**
   * The plan and status part of an edit, made consistent (audit 8 T13), or
   * a Spanish 400. Returns the columns to write on top of the patch.
   */
  private subscriptionPatch(existing: Tenant, patch: UpdateTenantDto, now: Date): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    const from = existing.subscriptionStatus;
    const to = patch.subscriptionStatus ?? from;
    const statusChanged = to !== from;
    const stripeLive = !!existing.stripeSubscriptionId && !isReadOnlyStatus(from);

    if (statusChanged && (to === "past_due" || to === "suspended")) {
      throw new BadRequestException(CONSOLE_EDIT_MESSAGES.stripeOwnedStatus);
    }

    const planChanged = patch.plan !== undefined && normalizePlan(patch.plan) !== normalizePlan(existing.plan);
    if (planChanged && stripeLive) {
      throw new BadRequestException(CONSOLE_EDIT_MESSAGES.planInStripe);
    }
    if (patch.plan !== undefined) out.plan = normalizePlan(patch.plan);
    if (to === "active" && !normalizePlan((out.plan as string | undefined) ?? existing.plan)) {
      throw new BadRequestException(CONSOLE_EDIT_MESSAGES.activeNeedsPlan);
    }

    if (to === "trialing") {
      const trialEnd = patch.trialEnd ?? existing.trialEnd;
      if (!trialEnd || trialEnd.getTime() <= now.getTime()) {
        throw new BadRequestException(
          patch.trialEnd ? CONSOLE_EDIT_MESSAGES.trialEndPast : CONSOLE_EDIT_MESSAGES.trialEnded,
        );
      }
      // Extending: the trial jobs read currentPeriodEnd too.
      if (patch.trialEnd) out.currentPeriodEnd = patch.trialEnd;
    } else if (patch.trialEnd && patch.trialEnd.getTime() <= now.getTime() && from === "trialing" && !statusChanged) {
      throw new BadRequestException(CONSOLE_EDIT_MESSAGES.trialEndPast);
    }

    if (statusChanged && isReadOnlyStatus(to) && !isReadOnlyStatus(from)) {
      if (stripeLive && !existing.subscriptionCancelAt) {
        throw new BadRequestException(CONSOLE_EDIT_MESSAGES.cancelInStripe);
      }
      Object.assign(out, STALE_RETENTION_RESET);
    }
    return out;
  }

  /**
   * Back from read-only (Reactivar, or an edit to Activo / En prueba): the
   * retention dates of the old read-only period go (audit 8 T4). Left
   * there, a later suspension saw a read-only end long past and a warning
   * "already given", and the next 04:40 run anonymised the salon. The
   * owner's own "Borrar mi salón" is not dropped silently: refused unless
   * cancelDeletion, which also cancels it (and is audit-logged).
   * subscriptionCancelAt is Stripe's and stays.
   */
  private async leaveReadOnly(tenant: Tenant, cancelDeletion: boolean, actorId?: string): Promise<Record<string, unknown>> {
    const data: Record<string, unknown> = {
      readOnlyUntil: null,
      cancelledAt: null,
      anonymizationWarnedAt: null,
      anonymizationWarnedFor: null,
    };
    if (tenant.deletionRequestedAt) {
      if (!cancelDeletion) {
        throw new ConflictException(pendingDeletionMessage(tenant.deletionRequestedAt));
      }
      data.deletionRequestedAt = null;
      data.deletionRestore = Prisma.DbNull;
      if (actorId) {
        await this.auditLog
          .record("tenant.deletion_cancelled", {
            actorId,
            actorRole: UserRole.saas_owner,
            tenantId: tenant.id,
            metadata: { by: "console", requestedAt: tenant.deletionRequestedAt.toISOString() },
          })
          .catch((err) => this.logger.warn(`Audit log tenant.deletion_cancelled for ${tenant.id} failed: ${(err as Error).message}`));
      }
    }
    return data;
  }

  async deleteTenant(id: string, saasOwnerId: string) {
    const tenant = await getActiveTenant(this.prisma, id);

    const deletedAt = new Date();

    // Stripe first, and nothing is deleted if it fails (audit 8 T14): a
    // salon deleted here while Stripe kept its subscription was charged
    // every month, and no job reconciles it. The Spanish 503 reaches the
    // console, which offers to try again. Ended at once whatever the status
    // here says: a salon suspended from the console is "cancelled" here
    // and may still be charged.
    await this.subscriptions.cancelStripeSubscriptionNow(id);

    // Soft delete + audit must be atomic: the audit_logs.actorId FK
    // requires a real User id; using a literal like "system" would
    // throw P2003. We pass the calling SaaS owner's id from the
    // controller (req.user.id) and write both rows in one transaction
    // via the callback form so we can call AuditLogService.record()
    // with the same transaction client.
    const auditRow = await this.prisma.$transaction(async (tx) => {
      await tx.tenant.update({
        where: { id },
        // As cancelling did before: cancelled now, its read-only window
        // from today.
        data: {
          deletedAt,
          subscriptionStatus: "cancelled",
          cancelledAt: tenant.cancelledAt ?? deletedAt,
          readOnlyUntil: new Date(deletedAt.getTime() + READ_ONLY_DAYS * DAY_MS),
          subscriptionCancelAt: null,
        },
        select: { id: true },
      });
      // Its team can no longer sign in, and every open session ends now
      // (jwt.strategy compares tokenVersion; login refuses a deleted salon).
      const users = await tx.user.updateMany({
        where: { tenantId: id, role: { not: UserRole.saas_owner } },
        data: { isActive: false, tokenVersion: { increment: 1 } },
      });
      // Its page answers 404 from now on; the iframe on its own site too.
      await invalidateTenantWidgets(tx, id);
      return this.auditLog.record(
        "tenant.soft_delete",
        {
          actorId: saasOwnerId,
          actorRole: UserRole.saas_owner,
          tenantId: id,
          metadata: { deletedAt: deletedAt.toISOString(), usersDeactivated: users.count },
        },
        tx,
      );
    });

    return {
      message: "Salón eliminado",
      deletedAt,
      auditLogId: auditRow.id,
    };
  }

  async suspendTenant(id: string) {
    const tenant = await getActiveTenant(this.prisma, id);

    const updated = await this.prisma.tenant.update({
      where: { id },
      data: {
        subscriptionStatus: "cancelled",
        ...(isReadOnlyStatus(tenant.subscriptionStatus) ? {} : STALE_RETENTION_RESET),
      },
      select: CONSOLE_TENANT_SELECT,
    });
    return consoleTenantView(updated);
  }

  /**
   * "Reactivar" (audit 8 T4): active again, without the retention dates of
   * the read-only period it leaves. A pending "Borrar mi salón" is refused
   * unless cancelDeletion, which cancels it too.
   */
  async reactivateTenant(id: string, opts: { cancelDeletion?: boolean } = {}, actorId?: string) {
    const tenant = await getActiveTenant(this.prisma, id);

    const updated = await this.prisma.tenant.update({
      where: { id },
      data: {
        subscriptionStatus: "active",
        ...(await this.leaveReadOnly(tenant, !!opts.cancelDeletion, actorId)),
      },
      select: CONSOLE_TENANT_SELECT,
    });
    return consoleTenantView(updated);
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
      // Every paying tenant with its location count: Empresa is billed per
      // location, so a per-plan count undercounts it.
      this.prisma.tenant.findMany({
        where: { subscriptionStatus: "active", ...TENANT_ACTIVE_WHERE },
        select: {
          plan: true,
          maxLocations: true,
          // Paid add-ons only: a manual grant (no Stripe item) bills nothing.
          tenantAddOns: {
            where: { status: "active", stripeSubscriptionItemId: { not: null } },
            select: {
              monthlyPriceCents: true,
              addOn: { select: { monthlyPriceCents: true, metered: true } },
            },
          },
        },
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

    // MRR in euros: each active tenant's plan price, times its locations
    // on Empresa. Legacy plan names count as the plan they map to; unknown
    // plans contribute 0 so a new enum value doesn't crash analytics.
    // (The console divided this by 100, as if it were cents, and showed
    // 0,49 € per Esencial salon.) Plus the add-ons each one pays for.
    const mrr = activePlanBreakdown.reduce(
      (sum, t) =>
        sum +
        monthlyPlanRevenue(
          t.plan,
          t.maxLocations,
          (t.tenantAddOns ?? [])
            .filter((a) => !a.addOn?.metered)
            .map((a) => a.monthlyPriceCents ?? a.addOn?.monthlyPriceCents ?? 0),
        ),
      0,
    );

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

const LEGACY_PLAN: Record<string, keyof typeof PLAN_PRICES> = {
  basic: "esencial",
  professional: "pro",
  advanced: "empresa",
  enterprise: "empresa",
};

/**
 * What a tenant on this plan pays per month, in euros, before VAT: the plan
 * (per location on Empresa) plus its paid add-ons, given as the monthly
 * cents each Stripe item bills. Add-ons were left out, so MRR undercounted
 * every salon that bought one.
 */
export function monthlyPlanRevenue(
  plan: string,
  locations: number | null | undefined,
  addOnMonthlyCents: ReadonlyArray<number | null | undefined> = [],
): number {
  const id = (LEGACY_PLAN[plan] ?? plan) as keyof typeof PLAN_PRICES;
  const price = PLAN_PRICES[id] ?? 0;
  const planRevenue = id === "empresa" ? price * Math.max(1, locations ?? 1) : price;
  const addOnCents = addOnMonthlyCents.reduce<number>(
    (sum, cents) => sum + (Number.isFinite(cents) && (cents as number) > 0 ? (cents as number) : 0),
    0,
  );
  // Summed in cents: 12.90 + 24 in floating-point euros drifts.
  return Math.round(planRevenue * 100 + addOnCents) / 100;
}
