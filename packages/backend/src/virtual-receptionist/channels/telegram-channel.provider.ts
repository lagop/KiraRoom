import { Injectable, Logger } from '@nestjs/common';
import * as crypto from 'crypto';
import { ChatChannel } from '@prisma/client';
import {
  ChannelProvider,
  NormalizedInbound,
  OutboundContext,
  SendResult,
} from './channel-provider.interface';

/**
 * P2A-receptionist-v2 H-4: Telegram Bot provider. Independent of Meta
 * (no Facebook Page required). Webhook signature uses
 * `X-Telegram-Bot-Api-Secret-Token` (HMAC of the request body with the
 * tenant's bot token). Send API is the standard Bot API.
 */
@Injectable()
export class TelegramChannelProvider implements ChannelProvider {
  readonly channel: ChatChannel = 'telegram';
  private readonly logger = new Logger(TelegramChannelProvider.name);

  constructor() {}

  verifyWebhook(req: any): boolean {
    const secret = req?.headers?.['x-telegram-bot-api-secret-token'];
    const expected = this.resolveBotTokenForRequest(req);
    if (!expected || !secret) return false;
    // Telegram's check is constant-time compare against the configured
    // secret. We use timingSafeEqual for the comparison.
    const a = Buffer.from(String(secret));
    const b = Buffer.from(String(expected));
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  async parseInbound(req: any): Promise<NormalizedInbound | null> {
    // Telegram sends two shapes:
    //  - full update:   { update_id, message: {...} }
    //  - wrapped:        { update: { ... } }
    // We accept both.
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
    const token = this.resolveBotTokenForRequest({ ctx: args.ctx });
    if (!token) {
      throw new Error('Telegram bot token is not configured for this tenant');
    }
    const url = `https://api.telegram.org/bot${token}/sendMessage`;
    const payload = {
      chat_id: Number(args.externalUserId),
      text: args.text,
    };
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json: any = await response.json();
    if (!response.ok) {
      const err = new Error(
        `Telegram send failed: ${json?.description ?? response.statusText}`,
      );
      this.logger.error(err.message);
      throw err;
    }
    return { messageId: String(json.result?.message_id), raw: json };
  }

  /**
   * The dispatcher passes the tenant's bot token via the outbound
   * ctx metadata. The webhook controller puts the verified token in
   * the request headers; this resolver is consistent for both paths.
   */
  private resolveBotTokenForRequest(req: any): string | undefined {
    const fromCtx = req?.ctx?.metadata?.telegramBotToken;
    if (fromCtx) return String(fromCtx);
    return undefined;
  }
}
