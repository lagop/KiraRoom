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
 * P2A-receptionist-v2 H-4: Facebook Messenger provider.
 *
 * The Meta Graph API endpoint for sending messages is shared
 * between Messenger and Instagram. The only difference is the
 * `recipient.id` shape and the inbound `metadata.platform` field on
 * the webhook. This provider hard-codes `recipient: { id: psid }`
 * and is the default for conversations whose `channel = 'facebook'`.
 */
@Injectable()
export class FacebookMessengerProvider implements ChannelProvider {
  readonly channel: ChatChannel = 'facebook';
  private readonly logger = new Logger(FacebookMessengerProvider.name);

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
        `Facebook Messenger send failed: ${json?.error?.message ?? response.statusText}`,
      );
      this.logger.error(err.message);
      throw err;
    }
    this.logger.log(
      `Facebook Messenger send -> ${args.externalUserId} (message_id=${json.message_id})`,
    );
    return { messageId: json.message_id, raw: json };
  }

  /**
   * P2A-receptionist-v2 H-4: the access token lives in
   * `Tenant.features.multichannel.meta.pageAccessToken` (encrypted at
   * rest by the SaaS-admin). Today we read it raw; future work
   * integrates with the existing `EncryptionService` to decrypt.
   */
  private async resolveAccessToken(tenantId: string): Promise<string> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { features: true },
    });
    const f = (tenant?.features as any) ?? {};
    const token = f?.multichannel?.meta?.pageAccessToken;
    if (!token) {
      throw new Error(
        `Facebook Messenger token missing for tenant ${tenantId}; complete the channel connection.`,
      );
    }
    return String(token);
  }
}
