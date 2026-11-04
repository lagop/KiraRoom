import { BadRequestException, Injectable, Logger, NotFoundException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { SubscriptionsService } from "../../payments/services/subscriptions.service";
import { isReadOnlyStatus } from "../../common/guards/read-only-tenant.guard";
import { AuditLogService } from "../audit-log.service";
import { assertNotPlatformTenant } from "../platform-tenant";
import { GdprService } from "./gdpr.service";

export const GDPR_CONSOLE_MESSAGES = {
  notFound: "Salón no encontrado",
  nameMismatch: "El nombre escrito no coincide con el del salón. No se ha anonimizado nada.",
  stillActive:
    "Este salón sigue activo (o en prueba, o con un pago pendiente). Para anonimizarlo igualmente, marca «Anonimizar aunque esté activo»: se cancelará su cobro en Stripe.",
} as const;

/** Same salon name, ignoring case, accents and repeated spaces. */
export function sameSalonName(typed: string, name: string): boolean {
  const norm = (s: string) =>
    (s ?? "")
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
  return norm(typed).length > 0 && norm(typed) === norm(name);
}

/**
 * The console's GDPR tools (audit 8 T5, T12, D14). Export: the request is
 * marked completed or failed. Anonymise: typed confirmation of the salon's
 * name; a salon still active, on trial or past due needs `force`; Stripe is
 * cancelled first (nothing happens if that fails); the invoices are always
 * kept (GdprService.anonymize); a GdprRequest and an audit row record it.
 */
@Injectable()
export class GdprConsoleService {
  private readonly logger = new Logger(GdprConsoleService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly gdpr: GdprService,
    private readonly subscriptions: SubscriptionsService,
    private readonly auditLog: AuditLogService,
  ) {}

  /** The export as plain JSON, its request marked completed or failed. */
  async export(tenantId: string, actorId: string, ip: string | undefined, format: "envelope" | "json") {
    await this.assertExists(tenantId);
    const rec = await this.gdpr.recordRequest(tenantId, "export", actorId, ip);
    try {
      const body = format === "json" ? await this.gdpr.exportJson(tenantId) : await this.gdpr.export(tenantId, rec.id);
      await this.gdpr.completeRequest(rec.id, `${body.length} bytes`);
      return { requestId: rec.id, body };
    } catch (err) {
      await this.gdpr.failRequest(rec.id, err);
      throw err;
    }
  }

  async anonymize(
    tenantId: string,
    actorId: string,
    ip: string | undefined,
    input: { confirmName: string; force?: boolean },
  ): Promise<{ ok: true; requestId: string }> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true, subscriptionStatus: true, deletedAt: true, anonymizedAt: true, stripeSubscriptionId: true },
    });
    if (!tenant) throw new NotFoundException(GDPR_CONSOLE_MESSAGES.notFound);
    // The Platform tenant holds the platform owner's own account (C14).
    await assertNotPlatformTenant(this.prisma, tenantId);
    if (!sameSalonName(input.confirmName, tenant.name)) {
      throw new BadRequestException(GDPR_CONSOLE_MESSAGES.nameMismatch);
    }
    const stillActive = !tenant.deletedAt && !tenant.anonymizedAt && !isReadOnlyStatus(tenant.subscriptionStatus);
    if (stillActive && !input.force) {
      throw new BadRequestException(GDPR_CONSOLE_MESSAGES.stillActive);
    }

    // Stripe first: a salon anonymised while Stripe kept charging it was
    // charged for an account that no longer exists. A failure is a Spanish
    // 503 and nothing is anonymised.
    await this.subscriptions.cancelStripeSubscriptionNow(tenantId);

    const rec = await this.gdpr.recordRequest(tenantId, "anonymize", actorId, ip);
    try {
      await this.gdpr.anonymize(tenantId, rec.id, { keepFiscalData: true });
    } catch (err) {
      await this.gdpr.failRequest(rec.id, err);
      throw err;
    }
    await this.auditLog
      // C9: one row, written after the scrub, so it carries nothing personal itself.
      .record("tenant.anonymize", {
        actorId,
        actorRole: UserRole.saas_owner,
        tenantId,
        metadata: {
          gdprRequestId: rec.id,
          forced: stillActive,
          previousStatus: tenant.subscriptionStatus,
          stripeSubscription: !!tenant.stripeSubscriptionId,
        },
      })
      .catch((err) => this.logger.warn(`Audit log tenant.anonymize for ${tenantId} failed: ${(err as Error).message}`));
    return { ok: true, requestId: rec.id };
  }

  async history(tenantId: string) {
    await this.assertExists(tenantId);
    return this.gdpr.listRequests(tenantId);
  }

  private async assertExists(tenantId: string) {
    const t = await this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { id: true } });
    if (!t) throw new NotFoundException(GDPR_CONSOLE_MESSAGES.notFound);
  }
}
