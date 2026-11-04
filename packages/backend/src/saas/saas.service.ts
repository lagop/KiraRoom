import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Optional,
} from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { randomBytes, randomUUID } from "crypto";
import { PasswordResetService } from "../auth/password-reset.service";
import { PrismaService } from "../common/prisma/prisma.service";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { UpdateTenantDto } from "./dto/update-tenant.dto";
import { TenantFilterDto } from "./dto/tenant-filter.dto";
import { UserRole } from "@prisma/client";
import * as bcrypt from "bcryptjs";
import {
  IMPERSONATION_TTL_SECONDS,
  IMPERSONATION_AUDIENCE,
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
import { normalizePlan, PLAN_PRICES, PlanId } from "@kira/shared";
import { assertNotPlatformTenant, NOT_PLATFORM_TENANT_WHERE } from "./platform-tenant";

/** The platform owner doing something in the console, for the audit log. */
export interface ConsoleActor {
  id: string;
  role?: string;
}

/** A value as the audit row keeps it (dates as ISO text). */
function auditValue(v: unknown): unknown {
  if (v instanceof Date) return v.toISOString();
  return v === undefined ? null : v;
}

/** The fields this patch changes, each with its value before and after. */
export function changedFields(
  before: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, { before: unknown; after: unknown }> {
  const out: Record<string, { before: unknown; after: unknown }> = {};
  for (const [key, next] of Object.entries(patch)) {
    if (next === undefined) continue;
    const prev = auditValue(before[key]);
    const after = auditValue(next);
    if (JSON.stringify(prev) !== JSON.stringify(after)) out[key] = { before: prev, after };
  }
  return out;
}

export interface PaginatedResult<T> {
  data: T[];
  meta: {
    total: number;
    page: number;
    limit: number;
    totalPages: number;
  };
}

@Injectable()
export class SaasService {
  private readonly logger = new Logger(SaasService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jwtService: JwtService,
    private readonly auditLog: AuditLogService,
    private readonly subscriptions: SubscriptionsService,
    @Optional() private readonly passwordReset?: PasswordResetService,
  ) {}

  async getAllTenants(filter: TenantFilterDto): Promise<PaginatedResult<any>> {
    const { page = 1, limit = 10, sortOrder = "desc", search, plan, subscriptionStatus, country, createdAfter, createdBefore, includeDeleted } = filter;
    // Only listed columns: ordering by a secret column (payment keys) would leak it bit by bit.
    const sortBy = (CONSOLE_TENANT_SORT_FIELDS as readonly string[]).includes(filter.sortBy ?? "")
      ? filter.sortBy!
      : "createdAt";

    // Not the Platform tenant: it is the platform owner's account, not a salon (C14).
    const where: any = { ...NOT_PLATFORM_TENANT_WHERE };

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
        orderBy: { [sortBy]: sortOrder === "asc" ? "asc" : "desc" },
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

    const shared = await this.sharedIdentity(tenants.map((t) => t.id));
    return {
      data: tenants.map((tenant) => ({
        ...tenant,
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

    const shared = await this.sharedIdentity([tenant.id]);
    return {
      ...tenant,
      sharedIdentity: shared.get(tenant.id) ?? [],
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
    // invites.acceptWithSlug.
    //
    // Without a password from the console the owner gets a random one
    // nobody knows (so no shared default can sign in) and, below, an email
    // with a link to choose her own.
    const setPasswordByEmail = !createTenantDto.ownerPassword;
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
      ownerPassword: createTenantDto.ownerPassword || unusablePassword(),
      ownerFirstName: createTenantDto.ownerFirstName,
      ownerLastName: createTenantDto.ownerLastName,
    });

    if (setPasswordByEmail && createTenantDto.ownerEmail) {
      // The reset flow: one-hour single-use link, same email and rate limits.
      // Expired, the owner asks for another from "¿Olvidaste tu contraseña?".
      try {
        await this.passwordReset?.request(createTenantDto.ownerEmail);
      } catch (err) {
        this.logger.warn(`set-password email for a new salon not sent: ${(err as Error).message}`);
      }
    }

    return this.prisma.tenant.findUniqueOrThrow({ where: { id: tenant.id } });
  }

  async updateTenant(id: string, updateTenantDto: UpdateTenantDto, actor: ConsoleActor) {
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

    // Audit 8, C8/C9: what changed, before and after, by the platform owner
    // who did it, in the same transaction as the change: a change is never
    // saved without its row. (The NIF row used to name "saas:system", which
    // is not a user: the foreign key refused it, and an empty catch hid it.)
    const changes = changedFields(existing as unknown as Record<string, unknown>, patch);
    const taxIdChanged = patch.taxId !== undefined && patch.taxId !== existing.taxId;
    const taxIdBefore = existing.taxId ?? null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        const updated = await tx.tenant.update({ where: { id }, data: patch });
        if (Object.keys(changes).length > 0) {
          await this.auditLog.record(
            "tenant.update",
            { actorId: actor.id, actorRole: UserRole.saas_owner, tenantId: id, metadata: { changes } },
            tx,
          );
        }
        // The emitter NIF has its own row, as the salon's own change does
        // (invoices.controller): fiscal audits look for it by action.
        if (taxIdChanged) {
          await this.auditLog.record(
            "tenant.taxId.change",
            {
              actorId: actor.id,
              actorRole: UserRole.saas_owner,
              tenantId: id,
              metadata: { before: taxIdBefore, after: patch.taxId, source: "saas/console" },
            },
            tx,
          );
        }
        return updated;
      });
    } catch (err) {
      this.logger.error(`Console update of tenant ${id} by ${actor.id} failed: ${(err as Error).message}`);
      throw err;
    }
  }

  async deleteTenant(id: string, saasOwnerId: string) {
    await getActiveTenant(this.prisma, id);
    await assertNotPlatformTenant(this.prisma, id);

    const deletedAt = new Date();

    // Best-effort Stripe cancellation. Done BEFORE the local soft-delete
    // so that a transient Stripe failure doesn't strand the tenant
    // in a deleted state with an active subscription. If Stripe is
    // unreachable, log and proceed — the local cancellation is the
    // source of truth for SaaS-side visibility, and the daily cron /
    // reconciliation job will sync Stripe later.
    try {
      // At once, not at the end of the paid period: the salon is deleted.
      await this.subscriptions.cancelSubscription(id, true);
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
      message: "Tenant soft-deleted successfully",
      deletedAt,
      auditLogId: auditRow.id,
    };
  }

  async suspendTenant(id: string, actor: ConsoleActor) {
    const tenant = await getActiveTenant(this.prisma, id);
    await assertNotPlatformTenant(this.prisma, id);
    return this.setStatusWithAudit(id, tenant.subscriptionStatus, "cancelled", "tenant.suspend", actor);
  }

  async reactivateTenant(id: string, actor: ConsoleActor) {
    const tenant = await getActiveTenant(this.prisma, id);
    return this.setStatusWithAudit(id, tenant.subscriptionStatus, "active", "tenant.reactivate", actor);
  }

  /** The status change and its audit row, together (C9). */
  private setStatusWithAudit(
    id: string,
    before: string,
    after: "cancelled" | "active",
    action: string,
    actor: ConsoleActor,
  ) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.tenant.update({ where: { id }, data: { subscriptionStatus: after } });
      await this.auditLog.record(
        action,
        {
          actorId: actor.id,
          actorRole: UserRole.saas_owner,
          tenantId: id,
          metadata: { subscriptionStatus: { before, after } },
        },
        tx,
      );
      return updated;
    });
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

  async getAllUsers(filter: TenantFilterDto) {
    const { page = 1, limit = 10, sortOrder = "desc", search, tenantId } = filter;
    // Only listed columns: ordering by a secret column would leak it bit by bit.
    const sortBy = (CONSOLE_USER_SORT_FIELDS as readonly string[]).includes(filter.sortBy ?? "")
      ? filter.sortBy!
      : "createdAt";

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
        orderBy: { [sortBy]: sortOrder === "asc" ? "asc" : "desc" },
        select: CONSOLE_USER_SELECT,
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
  async launchSalonDashboard(tenantId: string, saasOwnerId: string, reason: string) {
    const tenant = await getActiveTenant(this.prisma, tenantId);
    await assertNotPlatformTenant(this.prisma, tenantId);
    // The console's session version goes into the token: logout everywhere
    // or a new password between now and the redeem voids it (C13).
    const saasOwner = await this.prisma.user.findUnique({
      where: { id: saasOwnerId },
      select: { tokenVersion: true },
    });

    // The Tenant model has no owner relation. Look up the owner User
    // by role; this matches the SaaS owner flow where each tenant has
    // exactly one user with role='owner'.
    const owner = await this.prisma.user.findFirst({
      where: { tenantId, role: "owner" },
      select: { id: true, email: true, firstName: true, lastName: true },
    });

    if (!owner) {
      throw new BadRequestException("Este salón no tiene dueña: no hay cuenta en la que entrar.");
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
        // C17: the reason typed in the console, signed: the redeem records
        // this one and nothing the browser sends.
        impersonate: { tenantId, ownerId: owner.id, reason: reason.trim() },
        tv: saasOwner?.tokenVersion ?? 0,
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

/**
 * A password for an owner the console created without one: 32 random bytes
 * nobody is told, so the account cannot be signed into until the owner sets
 * her own from the emailed link.
 */
export function unusablePassword(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * The user columns the console's user list shows. An explicit select: the
 * list used to send every column (password hash, 2FA secrets and recovery
 * codes, reset and verification tokens, session version) to the browser.
 */
export const CONSOLE_USER_SELECT = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  role: true,
  isActive: true,
  createdAt: true,
  lastLoginAt: true,
  tenantId: true,
  tenant: { select: { id: true, name: true, slug: true } },
} as const;

/** Columns GET /saas/users may sort by. */
export const CONSOLE_USER_SORT_FIELDS = ["createdAt", "email", "firstName", "lastName", "role", "lastLoginAt"] as const;

/** Columns GET /saas/tenants may sort by. */
export const CONSOLE_TENANT_SORT_FIELDS = [
  "createdAt",
  "updatedAt",
  "name",
  "slug",
  "plan",
  "subscriptionStatus",
  "country",
  "trialEnd",
] as const;
