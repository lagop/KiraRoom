import { Injectable, Logger, Optional } from '@nestjs/common';
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
import { ChannelHealthService } from '../../channel-health/channel-health.service';

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
    @Optional() private readonly health?: ChannelHealthService,
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
    const parts = splitForChannel(toPlainChatText(args.text), CHANNEL_TEXT_LIMIT.instagram);
    let first: string | undefined;
    for (let i = 0; i < parts.length; i++) {
      const res = await this.graph.sendInstagramText(creds.pageToken, args.externalUserId, parts[i]);
      if (!res.ok) {
        // Instagram goes out with the Page's token: a refused token is the Page's.
        await this.health?.pageTokenError(args.ctx.tenantId, res.error?.code);
        const err = new Error(`Instagram DM send failed: ${res.error?.message}`);
        this.logger.error(err.message);
        // Part of the answer already arrived: throwing would make the
        // caller send the whole answer again, repeating that part.
        if (i > 0) return { messageId: first ?? '', raw: { partial: true, sent: i, total: parts.length } };
        throw err;
      }
      first ??= res.data?.message_id;
    }
    return { messageId: first ?? '' };
  }
}
