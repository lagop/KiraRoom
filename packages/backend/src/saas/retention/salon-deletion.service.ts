import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as bcrypt from "bcryptjs";
import { PrismaService } from "../../common/prisma/prisma.service";
import { SubscriptionsService } from "../../payments/services/subscriptions.service";
import { TwoFactorService } from "../../auth/two-factor/two-factor.service";
import { EmailService } from "../../notifications/services/email.service";
import { AuditLogService } from "../audit-log.service";
import { DAY_MS, READ_ONLY_DAYS, anonymizationDate } from "./salon-retention";

/** What "Borrar mi salón" restores when the owner changes her mind. */
export interface DeletionRestore {
  status: string;
  readOnlyUntil: string | null;
  cancelledAt: string | null;
  subscriptionCancelAt: string | null;
  /** The deletion set the Stripe subscription to end with its period (it was renewing). */
  stripeScheduled: boolean;
}

export interface DeletionStatus {
  pending: boolean;
  requestedAt: string | null;
  /** Until when the data can be exported (end of read-only). */
  exportUntil: string | null;
  /** When it is anonymised. */
  anonymizeOn: string | null;
  twoFactorRequired: boolean;
}

export const DELETION_ALREADY_PENDING = "Ya has pedido borrar el salón. Puedes anular el borrado mientras no se haya completado.";
export const DELETION_NOT_PENDING = "No hay ningún borrado pendiente para este salón.";

/**
 * "Borrar mi salón" (Ajustes > Seguridad, owner only; audit 7 D7).
 *
 * Asking: the password (and the 2FA code when she has it) is checked, then
 * the salon goes read-only now for READ_ONLY_DAYS to export, and is
 * anonymised ANONYMIZE_AFTER_READ_ONLY_DAYS after, by the retention job,
 * like any salon that left. A subscription that renews is set to end with
 * the period already paid (Stripe cancel_at_period_end): nothing more is
 * charged. A trial without one is cancelled at once. What it had before is
 * kept in deletionRestore.
 *
 * Cancelling it (while pending): what was there comes back. A subscription
 * set to end by the deletion renews again; if Stripe has ended it in the
 * meantime the salon stays read-only and can choose a plan in Facturación.
 */
@Injectable()
export class SalonDeletionService {
  private readonly logger = new Logger(SalonDeletionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly subscriptions: SubscriptionsService,
    private readonly twoFactor: TwoFactorService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
    private readonly auditLog: AuditLogService,
  ) {}

  async status(tenantId: string, userId: string): Promise<DeletionStatus> {
    const [tenant, user] = await Promise.all([
      this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { deletionRequestedAt: true, readOnlyUntil: true },
      }),
      this.prisma.user.findUnique({ where: { id: userId }, select: { twoFactorEnabled: true } }),
    ]);
    if (!tenant) throw new NotFoundException("Salón no encontrado");
    const pending = !!tenant.deletionRequestedAt;
    return {
      pending,
      requestedAt: tenant.deletionRequestedAt?.toISOString() ?? null,
      exportUntil: pending && tenant.readOnlyUntil ? tenant.readOnlyUntil.toISOString() : null,
      anonymizeOn: pending && tenant.readOnlyUntil ? anonymizationDate(tenant.readOnlyUntil).toISOString() : null,
      twoFactorRequired: !!user?.twoFactorEnabled,
    };
  }

  async request(
    tenantId: string,
    actor: { id: string; role: string },
    credentials: { password?: string; code?: string },
    now: Date = new Date(),
  ): Promise<DeletionStatus> {
    if (actor.role !== "owner") throw new ForbiddenException("Solo la dueña del salón puede borrarlo.");
    await this.checkCredentials(actor.id, tenantId, credentials, now);

    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt) throw new NotFoundException("Salón no encontrado");
    if (tenant.deletionRequestedAt) throw new ConflictException(DELETION_ALREADY_PENDING);

    const restore: DeletionRestore = {
      status: tenant.subscriptionStatus,
      readOnlyUntil: tenant.readOnlyUntil?.toISOString() ?? null,
      cancelledAt: tenant.cancelledAt?.toISOString() ?? null,
      subscriptionCancelAt: tenant.subscriptionCancelAt?.toISOString() ?? null,
      stripeScheduled: false,
    };

    // Billing first: a renewing subscription ends with the paid period, a
    // trial without one is cancelled. A Stripe failure is a Spanish 503 from
    // cancelSubscription, and nothing below happens.
    const readOnlyStatuses = ["cancelled", "suspended"];
    if (!readOnlyStatuses.includes(tenant.subscriptionStatus)) {
      const renewing = !!tenant.stripeSubscriptionId && !tenant.subscriptionCancelAt;
      await this.subscriptions.cancelSubscription(tenantId);
      restore.stripeScheduled = renewing && tenant.subscriptionStatus !== "past_due";
    }

    const readOnlyUntil = new Date(now.getTime() + READ_ONLY_DAYS * DAY_MS);
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        subscriptionStatus: "cancelled",
        cancelledAt: tenant.cancelledAt ?? now,
        readOnlyUntil,
        deletionRequestedAt: now,
        deletionRestore: restore as any,
      },
    });
    // Its sessions keep their old status in the token until the next
    // request reads it again (jwt.strategy): read-only from then on.
    await this.audit("tenant.deletion_requested", actor, tenantId, {
      readOnlyUntil: readOnlyUntil.toISOString(),
      anonymizeOn: anonymizationDate(readOnlyUntil).toISOString(),
      previousStatus: restore.status,
    });
    await this.notifyOwner(tenantId, tenant.name, readOnlyUntil);
    this.logger.warn(`Tenant ${tenantId}: the owner asked to delete it; anonymisation on ${anonymizationDate(readOnlyUntil).toISOString()}`);
    return this.status(tenantId, actor.id);
  }

  async cancel(tenantId: string, actor: { id: string; role: string }, now: Date = new Date()): Promise<DeletionStatus> {
    if (actor.role !== "owner") throw new ForbiddenException("Solo la dueña del salón puede anular el borrado.");
    const tenant = await this.prisma.tenant.findUnique({ where: { id: tenantId } });
    if (!tenant || tenant.deletedAt || tenant.anonymizedAt) throw new NotFoundException("Salón no encontrado");
    if (!tenant.deletionRequestedAt) throw new ConflictException(DELETION_NOT_PENDING);
    const restore = (tenant.deletionRestore ?? null) as unknown as DeletionRestore | null;

    const date = (v: string | null | undefined) => (v ? new Date(v) : null);
    let data: Record<string, unknown>;
    if (restore && restore.stripeScheduled && tenant.stripeSubscriptionId) {
      // The subscription renews again; the salon goes back to what it was.
      await this.prisma.tenant.update({
        where: { id: tenantId },
        data: { subscriptionStatus: restore.status as any, readOnlyUntil: date(restore.readOnlyUntil), cancelledAt: date(restore.cancelledAt) },
      });
      try {
        await this.subscriptions.undoCancellation(tenantId);
        data = { subscriptionCancelAt: null };
      } catch (err) {
        // Stripe has ended it, or cannot be reached: back to read-only as
        // after any cancellation, and the owner chooses a plan again.
        this.logger.warn(`Tenant ${tenantId}: cancelling the deletion could not renew the subscription: ${(err as Error).message}`);
        data = {
          subscriptionStatus: "cancelled",
          readOnlyUntil: tenant.readOnlyUntil,
          cancelledAt: tenant.cancelledAt ?? now,
        };
      }
    } else if (restore && restore.status === "trialing" && tenant.trialEnd && tenant.trialEnd > now) {
      data = { subscriptionStatus: "trialing", readOnlyUntil: null, cancelledAt: null, stripeSubscriptionId: null };
    } else if (restore && ["cancelled", "suspended"].includes(restore.status)) {
      // It was read-only already: its own period again, at least a fresh
      // read-only window if that one has run out meanwhile.
      const previous = date(restore.readOnlyUntil);
      const fresh = new Date(now.getTime() + READ_ONLY_DAYS * DAY_MS);
      data = {
        subscriptionStatus: restore.status,
        readOnlyUntil: previous && previous > now ? previous : fresh,
        cancelledAt: date(restore.cancelledAt),
      };
    } else {
      // A trial that has ended, or a paid period Stripe ends anyway: read-only
      // as after any cancellation; the owner can choose a plan in Facturación.
      data = { subscriptionStatus: "cancelled", readOnlyUntil: tenant.readOnlyUntil, cancelledAt: tenant.cancelledAt ?? now };
    }

    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: {
        ...data,
        deletionRequestedAt: null,
        deletionRestore: null as any,
        anonymizationWarnedAt: null,
        anonymizationWarnedFor: null,
      } as any,
    });
    await this.audit("tenant.deletion_cancelled", actor, tenantId, { status: data.subscriptionStatus ?? restore?.status });
    return this.status(tenantId, actor.id);
  }

  /** The password, and the 2FA code when two-step verification is on. Wrong: a 400 (a 401 signs the panel out). */
  private async checkCredentials(userId: string, tenantId: string, c: { password?: string; code?: string }, now: Date) {
    const user = await this.prisma.user.findFirst({
      where: { id: userId, tenantId },
      select: { passwordHash: true, twoFactorEnabled: true },
    });
    if (!user) throw new NotFoundException("Usuario no encontrado");
    if (!c.password || !(await bcrypt.compare(c.password, user.passwordHash))) {
      throw new BadRequestException("La contraseña no es correcta.");
    }
    if (user.twoFactorEnabled) {
      if (!c.code) throw new BadRequestException("Escribe el código de tu app de verificación.");
      if (!(await this.twoFactor.verifyForLogin(userId, c.code, now))) {
        throw new BadRequestException("El código no es correcto.");
      }
    }
  }

  private async notifyOwner(tenantId: string, tenantName: string, readOnlyUntil: Date) {
    try {
      const owner = await this.prisma.user.findFirst({ where: { tenantId, role: "owner" }, select: { email: true } });
      if (!owner?.email) return;
      const base = (this.config.get<string>("APP_BASE_URL") || this.config.get<string>("FRONTEND_URL") || "https://app.kiraroom.net").replace(/\/+$/, "");
      await this.email.sendAccountReadOnly({
        to: owner.email,
        tenantName,
        reason: "deletion_requested",
        readOnlyUntil,
        billingUrl: `${base}/dashboard/settings/seguridad`,
      });
    } catch (err) {
      this.logger.warn(`Deletion email for ${tenantId} not sent: ${(err as Error).message}`);
    }
  }

  private async audit(action: string, actor: { id: string; role: string }, tenantId: string, metadata: Record<string, unknown>) {
    try {
      await this.auditLog.record(action, { actorId: actor.id, actorRole: actor.role as any, tenantId, metadata });
    } catch (err) {
      this.logger.warn(`Audit log ${action} for ${tenantId} failed: ${(err as Error).message}`);
    }
  }
}
