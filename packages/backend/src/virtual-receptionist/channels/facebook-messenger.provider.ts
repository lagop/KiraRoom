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
 * Facebook Messenger: the receptionist's answers to people who write to the
 * salon's Facebook Page.
 *
 * Sent with the Page's own access token (obtained when the salon connected
 * the Page through Facebook Login) to POST /{PAGE_ID}/messages, as a
 * RESPONSE inside the 24-hour window the person's message opened. The token
 * used to be read in clear text from the tenant's JSON and the request went
 * to /me/messages; it is now decrypted per send.
 */
@Injectable()
export class FacebookMessengerProvider implements ChannelProvider {
  readonly channel: ChatChannel = 'facebook';
  private readonly logger = new Logger(FacebookMessengerProvider.name);

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
      channel: 'facebook',
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
    if (!creds) {
      throw new Error(
        `Facebook Messenger is not connected for tenant ${args.ctx.tenantId}; connect the Page first.`,
      );
    }
    const parts = splitForChannel(toPlainChatText(args.text), CHANNEL_TEXT_LIMIT.facebook);
    let first: string | undefined;
    for (let i = 0; i < parts.length; i++) {
      const res = await this.graph.sendMessengerText(creds.pageId, creds.pageToken, args.externalUserId, parts[i]);
      if (!res.ok) {
        await this.health?.pageTokenError(args.ctx.tenantId, res.error?.code);
        const err = new Error(`Facebook Messenger send failed: ${res.error?.message}`);
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
