import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../common/prisma/prisma.service";
import { TOKEN_EXPIRED_REASON, accountLevelReason } from "../whatsapp/campaigns/meta-account-errors";

/** Graph API codes that mean a Page token is no longer valid (expired, revoked, password changed). */
const PAGE_TOKEN_CODES = new Set([102, 190]);
/** Bot API codes for a token Telegram no longer knows (revoked in @BotFather, bot deleted). */
const BOT_TOKEN_CODES = new Set([401, 404]);

/** A Meta error code on a WhatsApp call that is about the salon's access token. */
export function isWhatsAppAuthError(code: number | string | null | undefined): boolean {
  if (code === null || code === undefined || code === "") return false;
  const n = Number(code);
  if (!Number.isFinite(n) || n < 0) return false;
  return accountLevelReason(n) === TOKEN_EXPIRED_REASON;
}

export function isPageTokenError(code: number | string | null | undefined): boolean {
  return code !== null && code !== undefined && PAGE_TOKEN_CODES.has(Number(code));
}

export function isBotTokenError(code: number | string | null | undefined): boolean {
  return code !== null && code !== undefined && BOT_TOKEN_CODES.has(Number(code));
}

/**
 * Whether Meta / Telegram still accept a salon's channel token.
 *
 * An expired or revoked token used to go unnoticed: the panel kept saying
 * "Conectado", reminders fell back to another channel (or were retried
 * against Meta) and the receptionist stopped answering, with only a line in
 * the log. Now the first auth error marks the connection (WhatsApp: on
 * whatsapp_connections; Messenger + Instagram, which share the Page token,
 * on the facebook ChannelAccount; Telegram on its own); the panel shows it,
 * sends stop trying until the salon reconnects, and ChannelAttentionScheduler
 * tells the owner once.
 *
 * Only marks: never throws, so a reporting failure cannot break a send.
 */
@Injectable()
export class ChannelHealthService {
  private readonly logger = new Logger(ChannelHealthService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** A WhatsApp Cloud API error. True when this call marked the connection. */
  async whatsAppError(tenantId: string, code: number | string | null | undefined): Promise<boolean> {
    if (!isWhatsAppAuthError(code)) return false;
    try {
      const res = await this.prisma.whatsAppConnection.updateMany({
        where: { tenantId, authErrorAt: null },
        data: { authErrorAt: new Date(), authError: `meta_${Number(code)}`, attentionNotifiedAt: null },
      });
      if (res.count > 0) this.logger.warn(`WhatsApp access of tenant ${tenantId} refused by Meta (meta_${Number(code)})`);
      return res.count > 0;
    } catch (err) {
      this.logger.error(`Could not mark the WhatsApp connection of tenant ${tenantId}: ${(err as Error).message}`);
      return false;
    }
  }

  /** A Graph error with the Page token (Messenger or Instagram). */
  pageTokenError(tenantId: string, code: number | string | null | undefined): Promise<boolean> {
    if (!isPageTokenError(code)) return Promise.resolve(false);
    return this.markAccount(tenantId, "facebook", `meta_${Number(code)}`);
  }

  /** A Bot API error with the salon's bot token. */
  botTokenError(tenantId: string, errorCode: number | string | null | undefined): Promise<boolean> {
    if (!isBotTokenError(errorCode)) return Promise.resolve(false);
    return this.markAccount(tenantId, "telegram", `telegram_${Number(errorCode)}`);
  }

  private async markAccount(tenantId: string, channel: "facebook" | "telegram", reason: string): Promise<boolean> {
    try {
      const res = await this.prisma.channelAccount.updateMany({
        where: { tenantId, channel, authErrorAt: null },
        data: { authErrorAt: new Date(), authError: reason, attentionNotifiedAt: null },
      });
      if (res.count > 0) this.logger.warn(`${channel} access of tenant ${tenantId} refused (${reason})`);
      return res.count > 0;
    } catch (err) {
      this.logger.error(`Could not mark the ${channel} account of tenant ${tenantId}: ${(err as Error).message}`);
      return false;
    }
  }
}
