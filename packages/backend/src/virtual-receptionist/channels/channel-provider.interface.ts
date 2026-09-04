import { ChatChannel } from '@prisma/client';

/**
 * Normalised inbound message after a provider-specific webhook is
 * parsed. The orchestrator doesn't care about the underlying channel
 * shape — only these fields.
 */
export interface NormalizedInbound {
  /** External user id (PSID for Messenger/IG, chat_id for Telegram). */
  externalUserId: string;
  /** Stable conversation key the provider uses to thread messages. */
  providerConversationId: string;
  /** Inbound text. May be empty for non-text events. */
  text: string;
  /** Channel of origin (matches ChatChannel enum). */
  channel: ChatChannel;
  /** Free-form passthrough for provider-specific metadata. */
  metadata: Record<string, unknown>;
  /** True if the inbound message is from a human user (vs a webhook ping). */
  isFromUser: boolean;
}

/**
 * Context the formatter can use to personalize a reply before the
 * provider serializes it.
 */
export interface OutboundContext {
  recipientName?: string;
  locale?: string;
  /** The ChatConversation id (Postgres UUID). */
  conversationId: string;
  /** Tenant id (for per-tenant branding if needed). */
  tenantId: string;
  /** Optional context object the provider can inspect. */
  metadata?: Record<string, unknown>;
}

export interface SendResult {
  messageId: string;
  raw?: unknown;
}

/**
 * P2A-receptionist-v2 H-4: contract every chat provider (Facebook
 * Messenger, Instagram, Telegram, Web) implements. The orchestrator
 * never imports a provider class directly; it asks the
 * ChannelRegistry for the provider by channel and delegates the
 * round trip.
 */
export interface ChannelProvider {
  readonly channel: ChatChannel;
  /** Verify the webhook signature. Throws on invalid. */
  verifyWebhook(req: any): boolean;
  /**
   * Parse an inbound webhook body into a NormalizedInbound. Returns
   * null for events the orchestrator doesn't care about (delivery
   * receipts, read markers, account updates, etc).
   */
  parseInbound(req: any): Promise<NormalizedInbound | null>;
  /**
   * Send a reply payload to the channel. The provider is responsible
   * for formatting the Graph API / Bot API request body.
   */
  send(args: {
    externalUserId: string;
    text: string;
    ctx: OutboundContext;
  }): Promise<SendResult>;
}
