import { z } from 'zod';

/**
 * P2A-receptionist-v2 H-4: channels configuration DTO.
 *
 * Persisted on `Tenant.features.multichannel.*` (JSON column on the
 * Tenant model).
 *
 * Channels supported by the registry (see `channel.registry.ts`):
 *   - web        (always on, no config required)
 *   - whatsapp   (configured in Ajustes > WhatsApp)
 *   - facebook   (Meta Messenger)
 *   - instagram  (Meta IG DMs)
 *   - telegram   (Bot API)
 *
 * Credentials are not part of this DTO: the Facebook Page is connected
 * through Facebook Login and the Telegram bot through its own endpoint,
 * and both tokens are stored encrypted by the backend.
 */

export const ChatChannelEnum = z.enum([
  'web',
  'whatsapp',
  'facebook',
  'instagram',
  'telegram',
]);

/** The switches the settings page can change. */
export const UpdateChannelsConfigSchema = z.object({
  /** Master switch. false = web only. */
  enabled: z.boolean().optional(),
  /** Subset of channels to activate for this tenant. */
  enabledChannels: z.array(ChatChannelEnum).max(8).optional(),
});
export type UpdateChannelsConfigDto = z.infer<typeof UpdateChannelsConfigSchema>;

/** Telegram: the token @BotFather gives (format: <id>:<35+ chars>). */
export const ConnectTelegramSchema = z.object({
  botToken: z
    .string()
    .regex(/^\d{6,12}:[A-Za-z0-9_-]{30,}$/, 'Invalid Telegram bot token format'),
});
export type ConnectTelegramDto = z.infer<typeof ConnectTelegramSchema>;

/** Read shape returned by the GET endpoint. Never carries a token. */
export interface ChannelsConfigView {
  enabled: boolean;
  enabledChannels: string[];
  meta: {
    configured: boolean;
    pageId?: string;
    pageName?: string;
    instagramBusinessAccountId?: string;
    instagramUsername?: string;
    /** Whether a Page access token is stored (never echoed back). */
    hasAccessToken: boolean;
    /** Saved by the first version and never subscribed to the webhook. */
    needsReconnect: boolean;
  } | null;
  /** Facebook Login returned several Pages and the salon has to pick one. */
  metaPagesPending: boolean;
  telegram: {
    configured: boolean;
    botUsername?: string;
    /** Whether a bot token is stored (never echoed back). */
    hasBotToken: boolean;
    /** Saved by the first version, whose webhook was never registered. */
    needsReconnect: boolean;
  } | null;
}
