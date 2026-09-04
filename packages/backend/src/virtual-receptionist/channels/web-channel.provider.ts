import { Injectable, Logger } from '@nestjs/common';
import { ChatChannel } from '@prisma/client';
import {
  ChannelProvider,
  NormalizedInbound,
  OutboundContext,
  SendResult,
} from './channel-provider.interface';

/**
 * P2A-receptionist-v2 H-4: Web channel is a no-op. The orchestrator
 * already persists the conversation in the same DB; replies are
 * streamed over WebSocket. This provider exists so the dispatcher
 * has a single interface for every channel (including "web").
 */
@Injectable()
export class WebChannelProvider implements ChannelProvider {
  readonly channel: ChatChannel = 'web';
  private readonly logger = new Logger(WebChannelProvider.name);

  verifyWebhook(_req: any): boolean {
    return true; // no signature on internal webhooks
  }

  async parseInbound(_req: any): Promise<NormalizedInbound | null> {
    return null; // web channel uses its own (deeper) ingestion path
  }

  async send(_args: { externalUserId: string; text: string; ctx: OutboundContext }): Promise<SendResult> {
    // Web replies are pushed by Gateway notifications, not by this
    // channel provider. The dispatcher only calls send() for
    // outbound messages on chat channels (whatsapp / facebook /
    // instagram / telegram). Return a stub here.
    return { messageId: `web-${Date.now()}` };
  }
}
