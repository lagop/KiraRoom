import { z } from 'zod';

/**
 * P2A-receptionist-v2 H-4: channels configuration DTO.
 *
 * Persisted on `Tenant.features.multichannel.*` (JSON column on the
 * Tenant model). The frontend wizard writes through this shape so the
 * shape and validation live in one place.
 *
 * Channels supported by the registry (see `channel.registry.ts`):
 *   - web        (always on, no config required)
 *   - whatsapp   (legacy fallback path)
 *   - facebook   (Meta Messenger)
 *   - instagram  (Meta IG DMs)
 *   - telegram   (Bot API)
 */

export const ChatChannelEnum = z.enum([
  'web',
  'whatsapp',
  'facebook',
  'instagram',
  'telegram',
]);

/** Configuration required to enable a Meta-based channel (FB + IG). */
export const MetaChannelConfigSchema = z.object({
  /** Numeric Facebook Page ID. */
  pageId: z.string().regex(/^\d{6,32}$/, 'pageId must be 6-32 digits'),
  /** Long-lived Page access token (EAA prefix). */
  pageAccessToken: z
    .string()
    .min(20, 'pageAccessToken is too short')
    .max(4096)
    .optional(),
  /** Optional: IG Business Account ID (set automatically when read from Meta). */
  instagramBusinessAccountId: z
    .string()
    .regex(/^\d{6,32}$/, 'instagramBusinessAccountId must be 6-32 digits')
    .optional(),
  /** Chat thread ids that have been linked to this tenant (derived, optional). */
  linkedChats: z.array(z.string()).optional(),
  /** Optional webhook verification secret (per-tenant). */
  webhookSecret: z.string().max(256).optional(),
});
export type MetaChannelConfig = z.infer<typeof MetaChannelConfigSchema>;

/** Configuration required to enable the Telegram channel. */
export const TelegramChannelConfigSchema = z.object({
  /** Bot token from @BotFather (format: <id>:<35+ chars>). */
  botToken: z
    .string()
    .regex(/^\d{6,12}:[A-Za-z0-9_-]{30,}$/, 'Invalid Telegram bot token format'),
  /** Chat thread ids that have sent at least one message (derived, optional). */
  linkedChats: z.array(z.string()).optional(),
});
export type TelegramChannelConfig = z.infer<typeof TelegramChannelConfigSchema>;

/**
 * The full multichannel configuration stored on Tenant.features.
 *
 * `enabledChannels` is the source of truth — the channel registry
 * reads it to decide which providers are active for the tenant.
 */
export const UpdateChannelsConfigSchema = z.object({
  /** Master switch. false = web only. */
  enabled: z.boolean().optional(),
  /** Subset of channels to activate for this tenant. */
  enabledChannels: z.array(ChatChannelEnum).max(8).optional(),
  /** Meta configuration (applies to both facebook + instagram). */
  meta: MetaChannelConfigSchema.optional(),
  /** Telegram configuration. */
  telegram: TelegramChannelConfigSchema.optional(),
});
export type UpdateChannelsConfigDto = z.infer<typeof UpdateChannelsConfigSchema>;

/** Read shape returned by the GET endpoint. */
export interface ChannelsConfigView {
  enabled: boolean;
  enabledChannels: string[];
  meta: {
    configured: boolean;
    pageId?: string;
    instagramBusinessAccountId?: string;
    linkedChats: string[];
    webhookSecret?: string;
    /** Whether a pageAccessToken is present (never echoed back). */
    hasAccessToken: boolean;
  } | null;
  telegram: {
    configured: boolean;
    botUsername?: string;
    linkedChats: string[];
    /** Whether a botToken is present (never echoed back). */
    hasBotToken: boolean;
  } | null;
}