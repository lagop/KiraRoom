import { Injectable, Logger } from '@nestjs/common';
import { ChatChannel } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  ChannelProvider,
  NormalizedInbound,
  OutboundContext,
  SendResult,
} from './channel-provider.interface';

/**
 * P2A-receptionist-v2 H-4: Instagram Direct Messages provider.
 *
 * The Meta Graph API is shared with Facebook Messenger
 * (`graph.facebook.com/v21.0/me/messages`); the only difference is
 * the `recipient.id` (IGSID vs PSID). On the inbound side the
 * webhook payload sets `metadata.platform === 'instagram'`.
 */
@Injectable()
export class InstagramChannelProvider implements ChannelProvider {
  readonly channel: ChatChannel = 'instagram';
  private readonly logger = new Logger(InstagramChannelProvider.name);

  constructor(private readonly prisma: PrismaService) {}

  verifyWebhook(_req: any): boolean {
    return true;
  }

  async parseInbound(req: any): Promise<NormalizedInbound | null> {
    const entry = req?.body?.entry?.[0];
    const event = entry?.messaging?.[0];
    if (!event || !event.message?.text) return null;
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
    const accessToken = await this.resolveAccessToken(args.ctx.tenantId);
    const url = `https://graph.facebook.com/v21.0/me/messages`;
    const payload = {
      recipient: { id: args.externalUserId },
      message: { text: args.text },
      messaging_type: 'RESPONSE',
    };
    const response = await fetch(`${url}?access_token=${accessToken}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const json: any = await response.json();
    if (!response.ok) {
      const err = new Error(
        `Instagram DM send failed: ${json?.error?.message ?? response.statusText}`,
      );
      this.logger.error(err.message);
      throw err;
    }
    this.logger.log(
      `Instagram DM send -> ${args.externalUserId} (message_id=${json.message_id})`,
    );
    return { messageId: json.message_id, raw: json };
  }

  private async resolveAccessToken(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { features: true },
    });
    const f = (tenant?.features as any) ?? {};
    const token = f?.multichannel?.meta?.pageAccessToken;
    if (!token) {
      throw new Error(
        `Instagram (Meta) token missing for tenant ${tenantId}; complete the channel connection.`,
      );
    }
    return String(token);
  }
}
