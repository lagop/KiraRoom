import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
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
import { Prisma, UserRole } from "@prisma/client";
import type { Tenant } from "@prisma/client";
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
import { normalizePlan, PLAN_PRICES } from "@kira/shared";
import { assertNotPlatformTenant, NOT_PLATFORM_TENANT_WHERE } from "./platform-tenant";
import { isReadOnlyStatus } from "../common/guards/read-only-tenant.guard";
import { normalizeWebAddress, WEB_ADDRESS_MESSAGES } from "../web-address/web-address-rules";
import { DAY_MS, READ_ONLY_DAYS } from "./retention/salon-retention";
import { EmailService } from "../notifications/services/email.service";
import { ConfigService } from "@nestjs/config";
import { moveTenantSlug, webAddressTaken } from "../web-address/web-address.service";
import { COURTESY_MESSAGES, courtesyUntilProblem } from "./retention/courtesy";
import {
  CONSOLE_EDIT_MESSAGES,
  CONSOLE_TENANT_SELECT,
  PLATFORM_ADDRESS_HINT,
  isPlatformAddress,
  STALE_RETENTION_RESET,
  consoleSlugProblem,
  consoleTenantView,
  pendingDeletionMessage,
  rethrowUniqueConflict,
  retentionView,
} from "./console-tenant";

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

/** The Spanish message of a refused address; the platform words say how a platform salon can have them (D7). */
function slugProblemMessage(problem: keyof typeof WEB_ADDRESS_MESSAGES): string {
  const base = WEB_ADDRESS_MESSAGES[problem];
  return problem === "platform_word" ? base + PLATFORM_ADDRESS_HINT : base;
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
    // The salon's email when "Suspender" ends its subscription (audit 8 D4).
    @Optional() private readonly email?: EmailService,
    @Optional() private readonly config?: ConfigService,
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
          // "Mostrar eliminados" marks them, and their actions are hidden (T9).
          deletedAt: true,
          blockedAt: true,
          courtesyUntil: true,
          courtesyPlan: true,
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

  async createTenant(createTenantDto: CreateTenantDto, actor?: ConsoleActor) {
    // At least 3 characters, letters without accents, digits and hyphens:
    // the form used to keep only the first letter typed ("s") and the API
    // took it (audit 8 T7). The reserved names stay as they were.
    const slug = createTenantDto.slug?.trim().length
      ? normalizeWebAddress(createTenantDto.slug)
      : slugify(createTenantDto.name);
    const platformAddress = !!createTenantDto.platformAddress;
    const shape = consoleSlugProblem(slug, { platformAddress });
    if (shape) throw new BadRequestException(slugProblemMessage(shape));

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
    }).catch(rethrowUniqueConflict);

    // D7: a platform address is on the audit log.
    if (platformAddress && isPlatformAddress(slug) && actor?.id) {
      await this.auditLog
        .record("tenant.platform_address", {
          actorId: actor.id,
          actorRole: UserRole.saas_owner,
          tenantId: tenant.id,
          metadata: { slug, on: "create" },
        })
        .catch((err) => this.logger.warn(`Audit log tenant.platform_address for ${tenant.id} failed: ${(err as Error).message}`));
    }

    if (setPasswordByEmail && createTenantDto.ownerEmail) {
      // The reset flow: one-hour single-use link, same email and rate limits.
      // Expired, the owner asks for another from "¿Olvidaste tu contraseña?".
      try {
        await this.passwordReset?.request(createTenantDto.ownerEmail);
      } catch (err) {
        this.logger.warn(`set-password email for a new salon not sent: ${(err as Error).message}`);
      }
    }

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
  async updateTenant(id: string, updateTenantDto: UpdateTenantDto, actor: ConsoleActor) {
    const existing = await getActiveTenant(this.prisma, id);
    const now = new Date();

    // P2A — Normalize NIF before persisting. Don't accept malformed
    // identifiers because AEAT / diputaciones reject them silently.
    const { platformAddress, slug: rawSlug, ...fields } = updateTenantDto;
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

    // T21 / D7: a new address goes through tenant_slug_redirects, as the
    // owner's own change does: the old one keeps redirecting for 12 months.
    let newSlug: string | null = null;
    if (rawSlug !== undefined) {
      const slug = normalizeWebAddress(rawSlug);
      if (slug !== existing.slug) {
        const shape = consoleSlugProblem(slug, { platformAddress: !!platformAddress });
        if (shape) throw new BadRequestException(slugProblemMessage(shape));
        if (await webAddressTaken(this.prisma, slug, id)) throw new ConflictException(WEB_ADDRESS_MESSAGES.taken);
        newSlug = slug;
      }
    }

    // Audit 8, C8/C9: what changed, before and after, by the platform owner
    // who did it, in the same transaction as the change: a change is never
    // saved without its row. (The NIF row used to name "saas:system", which
    // is not a user: the foreign key refused it, and an empty catch hid it.)
    // deletionRestore is a JSON marker, not a value to compare.
    const { deletionRestore: _restore, ...comparable } = patch;
    void _restore;
    const changes = changedFields(existing as unknown as Record<string, unknown>, comparable);
    const taxIdChanged = patch.taxId !== undefined && patch.taxId !== existing.taxId;
    const taxIdBefore = existing.taxId ?? null;
    try {
      return await this.prisma.$transaction(async (tx) => {
        if (newSlug) {
          const oldSlug = existing.slug;
          const redirectsUntil = await moveTenantSlug(tx, { tenantId: id, from: oldSlug, to: newSlug, now, ownerChange: false });
          await this.auditLog.record(
            "tenant.web_address_changed",
            {
              actorId: actor.id,
              actorRole: UserRole.saas_owner,
              tenantId: id,
              metadata: {
                from: oldSlug,
                to: newSlug,
                redirectsUntil: redirectsUntil?.toISOString() ?? null,
                source: "saas/console",
                platformAddress: !!platformAddress && isPlatformAddress(newSlug),
              },
            },
            tx,
          );
        }
        const updated = await tx.tenant.update({ where: { id }, data: patch, select: CONSOLE_TENANT_SELECT });
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
        return consoleTenantView(updated);
      });
    } catch (err) {
      this.logger.error(`Console update of tenant ${id} by ${actor.id} failed: ${(err as Error).message}`);
      rethrowUniqueConflict(err);
    }
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
    // Audit 8 D4 / D6: leaving read-only, or active without Stripe, is a
    // courtesy (plan and end date); entering read-only is "Suspender".
    if (statusChanged && isReadOnlyStatus(to) && !isReadOnlyStatus(from)) {
      throw new BadRequestException(CONSOLE_EDIT_MESSAGES.useSuspend);
    }
    if (statusChanged && isReadOnlyStatus(from)) {
      throw new BadRequestException(CONSOLE_EDIT_MESSAGES.useCourtesy);
    }
    if (statusChanged && to === "active" && !existing.stripeSubscriptionId) {
      throw new BadRequestException(CONSOLE_EDIT_MESSAGES.useCourtesy);
    }

    const planChanged = patch.plan !== undefined && normalizePlan(patch.plan) !== normalizePlan(existing.plan);
    if (planChanged && stripeLive) {
      throw new BadRequestException(CONSOLE_EDIT_MESSAGES.planInStripe);
    }
    if (patch.plan !== undefined) out.plan = normalizePlan(patch.plan);
    // A courtesy in course goes on with the new plan.
    if (planChanged && existing.courtesyUntil) out.courtesyPlan = out.plan;
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

    return out;
  }

  /**
   * Back from read-only (Cortesía, audit 8 D6; an edit no longer can): the
   * retention dates of the old read-only period go (audit 8 T4). Left
   * there, a later suspension saw a read-only end long past and a warning
   * "already given", and the next 04:40 run anonymised the salon. The
   * owner's own "Borrar mi salón" is not dropped silently: refused unless
   * cancelDeletion, which also cancels it (the change is on the
   * tenant.courtesy audit row).
   * subscriptionCancelAt is Stripe's and stays.
   */
  private leaveReadOnly(tenant: Tenant, cancelDeletion: boolean): Record<string, unknown> {
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
    }
    return data;
  }

  async deleteTenant(id: string, saasOwnerId: string) {
    const tenant = await getActiveTenant(this.prisma, id);
    await assertNotPlatformTenant(this.prisma, id);

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

  /**
   * "Suspender" (audit 8 D4, owner's decision 2026-11-04): a real end of the
   * subscription. Stripe is cancelled first (a failure is a Spanish 503 and
   * nothing changes), then the salon is read-only for READ_ONLY_DAYS like any
   * salon that left, cancelledAt set (the churn figures count by it), and its
   * owner is emailed in Spanish. The retention job anonymises it 30 days
   * after the read-only end.
   */
  async suspendTenant(id: string, actor: ConsoleActor, now: Date = new Date()) {
    const tenant = await getActiveTenant(this.prisma, id);
    await assertNotPlatformTenant(this.prisma, id);
    if (tenant.blockedAt) throw new BadRequestException(CONSOLE_EDIT_MESSAGES.blocked);
    if (isReadOnlyStatus(tenant.subscriptionStatus)) throw new BadRequestException(CONSOLE_EDIT_MESSAGES.alreadyReadOnly);

    const stripe = await this.subscriptions.cancelStripeSubscriptionNow(id);
    const readOnlyUntil = new Date(now.getTime() + READ_ONLY_DAYS * DAY_MS);
    const view = await this.setStatusWithAudit(
      id,
      tenant.subscriptionStatus,
      "cancelled",
      "tenant.suspend",
      actor,
      {
        cancelledAt: now,
        readOnlyUntil,
        subscriptionCancelAt: null,
        courtesyUntil: null,
        courtesyPlan: null,
        courtesyWarnedAt: null,
        anonymizationWarnedAt: null,
        anonymizationWarnedFor: null,
      },
      { readOnlyUntil: readOnlyUntil.toISOString(), stripeCancelled: stripe.cancelled },
    );
    await this.emailOwner(id, (to) =>
      this.email!.sendAccountReadOnly({
        to,
        tenantName: tenant.name,
        reason: "platform_cancelled",
        readOnlyUntil,
        billingUrl: `${this.appBase()}/dashboard/billing`,
      }),
    );
    return view;
  }

  /**
   * "Bloquear" (audit 8 D4, abuse): access ends now (sign-in refused with a
   * neutral message, sessions ended), its page is offline, nothing is sent
   * and nothing is charged (Stripe collection paused; a Stripe failure is a
   * Spanish 503 and nothing changes). The status stays as it was, so
   * "Desbloquear" puts everything back.
   */
  async blockTenant(id: string, reason: string, actor: ConsoleActor, now: Date = new Date()) {
    const tenant = await getActiveTenant(this.prisma, id);
    await assertNotPlatformTenant(this.prisma, id);
    if (tenant.blockedAt) throw new BadRequestException(CONSOLE_EDIT_MESSAGES.alreadyBlocked);
    const stripe = await this.subscriptions.setStripeCollectionPaused(id, true);
    const why = reason.trim().slice(0, 500);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.tenant.update({
        where: { id },
        data: { blockedAt: now, blockedReason: why },
        select: CONSOLE_TENANT_SELECT,
      });
      // Every open session of its team ends now (jwt.strategy compares tokenVersion).
      const users = await tx.user.updateMany({
        where: { tenantId: id, role: { not: UserRole.saas_owner } },
        data: { tokenVersion: { increment: 1 } },
      });
      await invalidateTenantWidgets(tx, id);
      await this.auditLog.record(
        "tenant.block",
        {
          actorId: actor.id,
          actorRole: UserRole.saas_owner,
          tenantId: id,
          metadata: { reason: why, sessionsEnded: users.count, stripeCollectionPaused: stripe.changed },
        },
        tx,
      );
      return consoleTenantView(updated);
    });
  }

  /** "Desbloquear": back as it was before the block; Stripe collection resumes first. */
  async unblockTenant(id: string, actor: ConsoleActor) {
    const tenant = await getActiveTenant(this.prisma, id);
    const blockedAt = tenant.blockedAt;
    if (!blockedAt) throw new BadRequestException(CONSOLE_EDIT_MESSAGES.notBlocked);
    const stripe = await this.subscriptions.setStripeCollectionPaused(id, false);
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.tenant.update({
        where: { id },
        data: { blockedAt: null, blockedReason: null },
        select: CONSOLE_TENANT_SELECT,
      });
      await this.auditLog.record(
        "tenant.unblock",
        {
          actorId: actor.id,
          actorRole: UserRole.saas_owner,
          tenantId: id,
          metadata: { blockedAt: blockedAt.toISOString(), stripeCollectionResumed: stripe.changed },
        },
        tx,
      );
      return consoleTenantView(updated);
    });
  }

  /**
   * "Cortesía" (audit 8 D6): active without paying, on a plan, until a date.
   * Replaces "Reactivar" without payment. Also extends a courtesy in course.
   * Leaving read-only clears the old retention dates (T4); a pending
   * "Borrar mi salón" is refused unless cancelDeletion, which cancels it too.
   * Not paying: out of MRR, and the never-paid email cap still applies.
   * CourtesyScheduler emails the owner 3 days before the end and puts it
   * back to read-only at the end.
   */
  async courtesyTenant(
    id: string,
    input: { plan: string; until: Date; cancelDeletion?: boolean },
    actor: ConsoleActor,
    now: Date = new Date(),
  ) {
    const tenant = await getActiveTenant(this.prisma, id);
    await assertNotPlatformTenant(this.prisma, id);
    if (tenant.blockedAt) throw new BadRequestException(COURTESY_MESSAGES.blocked);
    if (tenant.stripeSubscriptionId && !isReadOnlyStatus(tenant.subscriptionStatus)) {
      throw new BadRequestException(COURTESY_MESSAGES.paysInStripe);
    }
    const plan = normalizePlan(input.plan);
    if (!plan) throw new BadRequestException(COURTESY_MESSAGES.planNeeded);
    const problem = courtesyUntilProblem(input.until, now);
    if (problem) throw new BadRequestException(problem);

    const extra: Record<string, unknown> = isReadOnlyStatus(tenant.subscriptionStatus)
      ? this.leaveReadOnly(tenant, !!input.cancelDeletion)
      : {};
    return this.setStatusWithAudit(
      id,
      tenant.subscriptionStatus,
      "active",
      "tenant.courtesy",
      actor,
      {
        ...extra,
        plan,
        courtesyPlan: plan,
        courtesyUntil: input.until,
        courtesyWarnedAt: null,
        currentPeriodEnd: input.until,
        // A Stripe subscription that ended with the read-only period is gone.
        ...(isReadOnlyStatus(tenant.subscriptionStatus) ? { stripeSubscriptionId: null, subscriptionCancelAt: null } : {}),
      },
      {
        courtesy: { plan, until: input.until.toISOString(), previousUntil: tenant.courtesyUntil?.toISOString() ?? null },
        ...(tenant.deletionRequestedAt && extra.deletionRequestedAt === null
          ? { deletionCancelled: { requestedAt: tenant.deletionRequestedAt.toISOString() } }
          : {}),
      },
    );
  }

  /** The owner's email, sent best-effort: the console action is already done. */
  private async emailOwner(tenantId: string, send: (to: string) => Promise<unknown>) {
    if (!this.email) return;
    try {
      const owner = await this.prisma.user.findFirst({ where: { tenantId, role: UserRole.owner }, select: { email: true } });
      if (owner?.email) await send(owner.email);
    } catch (err) {
      this.logger.warn(`Email to the owner of ${tenantId} not sent: ${(err as Error).message}`);
    }
  }

  private appBase(): string {
    const base = this.config?.get<string>("APP_BASE_URL") || this.config?.get<string>("FRONTEND_URL") || "https://app.kiraroom.net";
    return base.replace(/\/+$/, "");
  }

  /** The status change and its audit row, together (C9). */
  private setStatusWithAudit(
    id: string,
    before: string,
    after: "cancelled" | "active",
    action: string,
    actor: ConsoleActor,
    extraData: Record<string, unknown> = {},
    extraMetadata: Record<string, unknown> = {},
  ) {
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.tenant.update({
        where: { id },
        data: { subscriptionStatus: after, ...extraData },
        select: CONSOLE_TENANT_SELECT,
      });
      await this.auditLog.record(
        action,
        {
          actorId: actor.id,
          actorRole: UserRole.saas_owner,
          tenantId: id,
          metadata: { subscriptionStatus: { before, after }, ...extraMetadata },
        },
        tx,
      );
      return consoleTenantView(updated);
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
