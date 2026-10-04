import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { ChatChannel } from '@prisma/client';
import {
  ChannelProvider,
  NormalizedInbound,
  OutboundContext,
  SendResult,
} from './channel-provider.interface';
import { ChannelCredentialsService } from './channel-credentials.service';
import { TelegramBotClient } from './telegram-bot.client';
import { CHANNEL_TEXT_LIMIT, splitForChannel, toPlainChatText } from './chat-text';

/**
 * Telegram: answers through the salon's own bot (created with @BotFather).
 *
 * Inbound updates reach /channels/webhooks/telegram/:tenantId, where the
 * X-Telegram-Bot-Api-Secret-Token header is compared with the secret
 * KiraRoom registered in setWebhook. Replies go through sendMessage with the
 * bot token, which is stored encrypted; it used to be expected in the
 * outbound context, where nothing ever put it, so no reply was ever sent.
 */
@Injectable()
export class TelegramChannelProvider implements ChannelProvider {
  readonly channel: ChatChannel = 'telegram';
  private readonly logger = new Logger(TelegramChannelProvider.name);

  constructor(
    private readonly credentials: ChannelCredentialsService,
    private readonly bot: TelegramBotClient,
  ) {}

  /**
   * Constant-time comparison of the header with the expected secret, which
   * the caller passes as `req.expectedSecret`.
   */
  verifyWebhook(req: any): boolean {
    const secret = req?.headers?.['x-telegram-bot-api-secret-token'];
    const expected = req?.expectedSecret;
    if (!expected || !secret) return false;
    const a = Buffer.from(String(secret));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  async parseInbound(req: any): Promise<NormalizedInbound | null> {
    // Telegram sends { update_id, message: {...} }; a wrapped
    // { update: { message } } shape is accepted too.
    const body = req?.body ?? {};
    const message = body?.message ?? body?.update?.message;
    if (!message || !message.text) return null;
    return {
      externalUserId: String(message.chat.id),
      providerConversationId: String(message.chat.id),
      text: message.text,
      channel: 'telegram',
      metadata: {
        messageId: String(message.message_id),
        from: message.from,
        chat: message.chat,
      },
      isFromUser: true,
    };
  }

  async send(args: { externalUserId: string; text: string; ctx: OutboundContext }): Promise<SendResult> {
    const creds = await this.credentials.telegram(args.ctx.tenantId);
    if (!creds) {
      throw new Error('Telegram bot token is not configured for this tenant');
    }
    let first: string | undefined;
    for (const part of splitForChannel(toPlainChatText(args.text), CHANNEL_TEXT_LIMIT.telegram)) {
      const res = await this.bot.sendMessage(creds.botToken, Number(args.externalUserId), part);
      if (!res.ok) {
        const err = new Error(`Telegram send failed: ${res.description ?? 'unknown error'}`);
        this.logger.error(err.message);
        throw err;
      }
      first ??= res.result?.message_id !== undefined ? String(res.result.message_id) : undefined;
    }
    return { messageId: first ?? '' };
  }
}
