import { Injectable, Logger } from '@nestjs/common';
import { ChatChannel } from '@prisma/client';
import {
  ChannelProvider,
  NormalizedInbound,
  OutboundContext,
  SendResult,
} from './channel-provider.interface';
import { ChannelCredentialsService } from './channel-credentials.service';
import { MetaGraphClient } from './meta-graph.client';
import { CHANNEL_TEXT_LIMIT, splitForChannel, toPlainChatText } from './chat-text';

/**
 * Instagram Direct: answers to people who write to the Instagram
 * professional account linked to the salon's Facebook Page.
 *
 * Messenger Platform for Instagram: POST /me/messages with the Page's access
 * token and the person's Instagram-scoped id. Instagram refuses texts of
 * 1000 characters or more, so long answers go out in several messages.
 */
@Injectable()
export class InstagramChannelProvider implements ChannelProvider {
  readonly channel: ChatChannel = 'instagram';
  private readonly logger = new Logger(InstagramChannelProvider.name);

  constructor(
    private readonly credentials: ChannelCredentialsService,
    private readonly graph: MetaGraphClient,
  ) {}

  /** Signatures are checked by the webhook controller (X-Hub-Signature-256). */
  verifyWebhook(_req: any): boolean {
    return true;
  }

  async parseInbound(req: any): Promise<NormalizedInbound | null> {
    const entry = req?.body?.entry?.[0];
    const event = entry?.messaging?.[0];
    if (!event || !event.message?.text || event.message?.is_echo) return null;
    return {
      externalUserId: event.sender.id,
      providerConversationId: event.sender.id,
      text: event.message.text,
      channel: 'instagram',
      metadata: { messageId: event.message.mid, raw: event },
      isFromUser: true,
    };
  }

  async send(args: {
    externalUserId: string;
    text: string;
    ctx: OutboundContext;
  }): Promise<SendResult> {
    const creds = await this.credentials.meta(args.ctx.tenantId);
    if (!creds?.instagramId) {
      throw new Error(
        `Instagram is not connected for tenant ${args.ctx.tenantId}; link an Instagram professional account to the Page.`,
      );
    }
    let first: string | undefined;
    for (const part of splitForChannel(toPlainChatText(args.text), CHANNEL_TEXT_LIMIT.instagram)) {
      const res = await this.graph.sendInstagramText(creds.pageToken, args.externalUserId, part);
      if (!res.ok) {
        const err = new Error(`Instagram DM send failed: ${res.error?.message}`);
        this.logger.error(err.message);
        throw err;
      }
      first ??= res.data?.message_id;
    }
    return { messageId: first ?? '' };
  }
}
