import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { PrismaService } from "../common/prisma/prisma.service";
import { runUnscoped } from "../common/tenancy/tenant.context";
import { EmailService } from "../notifications/services/email.service";

export type ReadOnlyReason = "trial_ended" | "cancelled";

/**
 * Emails the owner the day their account becomes read-only because the
 * trial ended or the subscription was cancelled. (A failed payment has its
 * own email, sent by `GracePeriodScheduler`.)
 *
 * Callers send it only when they made the transition themselves, through a
 * conditional update that matched the row, so a re-run of the daily job or
 * a Stripe webhook arriving after a dashboard cancellation cannot send it
 * twice. Never throws: a failed email must not undo or block the change.
 */
@Injectable()
export class ReadOnlyNoticeService {
  private readonly logger = new Logger(ReadOnlyNoticeService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  async notify(tenantId: string, reason: ReadOnlyReason, readOnlyUntil: Date): Promise<void> {
    try {
      const tenant = await runUnscoped(() =>
        this.prisma.tenant.findUnique({ where: { id: tenantId }, select: { name: true, deletedAt: true } }),
      );
      if (!tenant || tenant.deletedAt) return;

      const owner = await runUnscoped(() =>
        this.prisma.user.findFirst({ where: { tenantId, role: "owner" }, select: { email: true } }),
      );
      if (!owner?.email) {
        this.logger.warn(`Tenant ${tenantId} (${tenant.name}) has no owner email; read-only notice (${reason}) not sent.`);
        return;
      }

      const baseUrl =
        this.config.get<string>("APP_BASE_URL") ||
        this.config.get<string>("FRONTEND_URL") ||
        "https://app.kiraroom.com";

      const sent = await this.email.sendAccountReadOnly({
        to: owner.email,
        tenantName: tenant.name,
        reason,
        readOnlyUntil,
        billingUrl: `${baseUrl.replace(/\/+$/, "")}/dashboard/billing`,
      });
      if (!sent.success && !sent.skipped) {
        this.logger.error(`Read-only notice (${reason}) for tenant ${tenantId} not sent: ${sent.error}`);
      }
    } catch (err) {
      this.logger.error(
        `Read-only notice (${reason}) for tenant ${tenantId} failed: ${(err as Error).message}`,
        (err as Error).stack,
      );
    }
  }
}
