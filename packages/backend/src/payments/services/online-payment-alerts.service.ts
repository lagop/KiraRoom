import { Injectable, Logger, Optional } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { NotificationsService } from '../../notifications/notifications.service';
import { NotificationType } from '../../notifications/dto';
import { EmailService } from '../../notifications/services/email.service';
import { escapeHtml } from '../../common/html-escape';

/** What a salon is told about its online payments when something needs a person. */
export interface OnlinePaymentNotice {
  title: string;
  /** Plain text: the panel notification and the email body. */
  message: string;
  /** Panel path the notice links to. */
  link: string;
  /** Same notice twice (Stripe retries, a second cancel) is sent once per key and manager. */
  key: string;
  type?: NotificationType;
}

const panelUrl = (path: string) =>
  `${String(process.env.FRONTEND_URL || 'http://localhost:3000').replace(/\/+$/, '')}${path}`;

/**
 * Tells the owners and admins of a salon, in the panel and by email, about an
 * online payment that needs them: a refund Stripe refused, a client's dispute
 * (chargeback). Never throws: a notice that cannot be sent must not undo the
 * payment event that caused it.
 */
@Injectable()
export class OnlinePaymentAlertsService {
  private readonly logger = new Logger(OnlinePaymentAlertsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    // Optional: specs that do not care about email leave it out.
    @Optional() private readonly email?: EmailService,
  ) {}

  async tellManagers(tenantId: string, notice: OnlinePaymentNotice): Promise<void> {
    try {
      const managers = await this.prisma.user.findMany({
        where: { tenantId, role: { in: ['owner', 'admin'] }, isActive: true },
        select: { id: true, email: true, firstName: true },
      });
      for (const manager of managers) {
        await this.notifications
          .create({
            tenantId,
            userId: manager.id,
            type: notice.type ?? NotificationType.PAYMENT_FAILED,
            title: notice.title,
            message: notice.message,
            data: { event: 'online_payment', link: notice.link },
          })
          .catch((err: Error) => this.logger.warn(`Could not notify ${manager.id}: ${err.message}`));
        if (!this.email || !manager.email) continue;
        const res = await this.email
          .sendEmail({
            to: manager.email,
            subject: notice.title,
            html: `<p>Hola${manager.firstName ? ` ${escapeHtml(manager.firstName)}` : ''},</p>
<p>${escapeHtml(notice.message)}</p>
<p><a href="${escapeHtml(panelUrl(notice.link))}">Abrir en KiraRoom</a></p>`,
            idempotencyKey: `${notice.key}-${manager.id}`,
          })
          .catch((err: Error) => ({ success: false, error: err.message }));
        if (!res.success) this.logger.warn(`Online payment email to a manager failed: ${(res as { error?: string }).error ?? 'unknown'}`);
      }
    } catch (err) {
      this.logger.warn(`Could not notify the managers of salon ${tenantId}: ${(err as Error).message}`);
    }
  }
}

/** The amount in euros for a sentence ("15,00 €"). */
export function eurosText(cents: number): string {
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}
