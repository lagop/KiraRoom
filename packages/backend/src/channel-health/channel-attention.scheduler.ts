import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import { Cron, CronExpression } from "@nestjs/schedule";
import { PrismaService } from "../common/prisma/prisma.service";
import { runUnscoped } from "../common/tenancy/tenant.context";
import { NotificationsService } from "../notifications/notifications.service";
import { EmailService } from "../notifications/services/email.service";

export type AttentionChannel = "whatsapp" | "facebook" | "telegram";

/** What the owner is told, in the panel and by email, per channel. */
export const ACCESS_LOST_NOTICE: Record<AttentionChannel, { title: string; message: string; path: string }> = {
  whatsapp: {
    title: "WhatsApp: Meta ha retirado el acceso de KiraRoom",
    message:
      "Meta ya no acepta el acceso de KiraRoom a tu WhatsApp Business: el token ha caducado o se ha revocado. Hasta que lo vuelvas a conectar no salen recordatorios ni campañas por WhatsApp y la recepcionista no contesta allí. Vuelve a conectarlo en Ajustes → WhatsApp Business.",
    path: "/dashboard/settings/whatsapp",
  },
  facebook: {
    title: "Messenger e Instagram: Facebook ha retirado el acceso de KiraRoom",
    message:
      "Facebook ya no acepta el permiso de KiraRoom sobre tu página: ha caducado o se ha retirado. La recepcionista no contesta en Messenger ni en Instagram hasta que vuelvas a conectar la página en Ajustes → Canales.",
    path: "/dashboard/settings/channels",
  },
  telegram: {
    title: "Telegram: el bot ya no acepta a KiraRoom",
    message:
      "Telegram ya no reconoce el token de tu bot: se ha cambiado o revocado en @BotFather. La recepcionista no contesta en Telegram hasta que vuelvas a conectar el bot en Ajustes → Canales.",
    path: "/dashboard/settings/channels",
  },
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/**
 * Tells a salon's owner and admins, once, that Meta or Telegram refused a
 * channel's token (marked by ChannelHealthService): a notice in the panel
 * for each of them and an email to the owner.
 *
 * A sweep rather than a call at the point of failure: the failures are seen
 * in WhatsAppMessagingModule, which NotificationsModule imports, so it
 * cannot depend on NotificationsService; and a sweep also catches a mark
 * whose notice was lost to a restart. Each notice is claimed with a
 * conditional update, so two instances never send it twice.
 */
@Injectable()
export class ChannelAttentionScheduler {
  private readonly logger = new Logger(ChannelAttentionScheduler.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationsService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async sweep(): Promise<void> {
    try {
      await runUnscoped(() => this.notifyPending());
    } catch (err) {
      this.logger.error(`Channel attention sweep failed: ${(err as Error).message}`);
    }
  }

  /** Returns how many notices were sent (for tests). */
  async notifyPending(): Promise<number> {
    let sent = 0;
    const whatsapp = await this.prisma.whatsAppConnection.findMany({
      where: { isActive: true, authErrorAt: { not: null }, attentionNotifiedAt: null },
      select: { tenantId: true },
      take: 50,
    });
    for (const { tenantId } of whatsapp) {
      const claimed = await this.prisma.whatsAppConnection.updateMany({
        where: { tenantId, authErrorAt: { not: null }, attentionNotifiedAt: null },
        data: { attentionNotifiedAt: new Date() },
      });
      if (claimed.count > 0 && (await this.notify(tenantId, "whatsapp"))) sent++;
    }

    const accounts = await this.prisma.channelAccount.findMany({
      where: { channel: { in: ["facebook", "telegram"] }, authErrorAt: { not: null }, attentionNotifiedAt: null },
      select: { id: true, tenantId: true, channel: true },
      take: 50,
    });
    for (const a of accounts) {
      const claimed = await this.prisma.channelAccount.updateMany({
        where: { id: a.id, authErrorAt: { not: null }, attentionNotifiedAt: null },
        data: { attentionNotifiedAt: new Date() },
      });
      if (claimed.count > 0 && (await this.notify(a.tenantId, a.channel as AttentionChannel))) sent++;
    }
    return sent;
  }

  private async notify(tenantId: string, channel: AttentionChannel): Promise<boolean> {
    const notice = ACCESS_LOST_NOTICE[channel];
    try {
      const managers = await this.prisma.user.findMany({
        where: { tenantId, role: { in: ["owner", "admin"] }, isActive: true },
        select: { id: true, email: true, role: true },
      });
      for (const m of managers) {
        await this.notifications.create({
          tenantId,
          userId: m.id,
          type: "system_alert" as any,
          title: notice.title,
          message: notice.message,
          data: { kind: "channel_access_lost", channel, url: notice.path },
        });
      }
      const owner = managers.find((m) => m.role === "owner");
      if (owner?.email) {
        const base = (
          this.config.get<string>("APP_BASE_URL") ||
          this.config.get<string>("FRONTEND_URL") ||
          "https://app.kiraroom.com"
        ).replace(/\/+$/, "");
        const link = `${base}${notice.path}`;
        const res = await this.email.sendEmail({
          to: owner.email,
          subject: notice.title,
          html: `<p>${escapeHtml(notice.message)}</p><p><a href="${escapeHtml(link)}">${escapeHtml(link)}</a></p>`,
          text: `${notice.message}\n\n${link}`,
          idempotencyKey: `channel-access-lost:${tenantId}:${channel}:${new Date().toISOString().slice(0, 10)}`,
        });
        if (!res.success && !(res as any).skipped) {
          this.logger.warn(`Channel access notice email for tenant ${tenantId} not sent: ${res.error}`);
        }
      }
      return true;
    } catch (err) {
      this.logger.error(`Channel access notice for tenant ${tenantId} (${channel}) failed: ${(err as Error).message}`);
      return false;
    }
  }
}
