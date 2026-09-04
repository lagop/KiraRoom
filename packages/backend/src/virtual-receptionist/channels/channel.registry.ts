import { Injectable, Logger } from '@nestjs/common';
import { ChatChannel } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { MetricsService, COUNTERS } from '../../common/observability/metrics.service';
import {
  ChannelProvider,
  NormalizedInbound,
  OutboundContext,
  SendResult,
} from './channel-provider.interface';
import { WebChannelProvider } from './web-channel.provider';
import { FacebookMessengerProvider } from './facebook-messenger.provider';
import { InstagramChannelProvider } from './instagram-channel.provider';
import { TelegramChannelProvider } from './telegram-channel.provider';

/**
 * P2A-receptionist-v2 H-4: per-tenant channel dispatch.
 *
 * Resolves `(tenantId, channel) -> ChannelProvider` using the
 * tenant's `features.multichannel` JSON. The orchestrator asks for a
 * provider by channel; the registry returns the configured one (or
 * falls back to the WebChannelProvider when the channel is disabled
 * for the tenant).
 */
@Injectable()
export class ChannelRegistry {
  private readonly logger = new Logger(ChannelRegistry.name);
  private readonly providers: Map<ChatChannel, ChannelProvider>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: MetricsService,
    web: WebChannelProvider,
    fb: FacebookMessengerProvider,
    ig: InstagramChannelProvider,
    tg: TelegramChannelProvider,
  ) {
    this.providers = new Map<ChatChannel, ChannelProvider>([
      ['web', web],
      ['whatsapp', web], // H-4: WhatsApp keeps the legacy path; the
                          // web provider is a safe fallback. The real
                          // outbound for WhatsApp still flows through
                          // whatsapp.service.ts (T-3 plan) so we don't
                          // double-send.
      ['facebook', fb],
      ['instagram', ig],
      ['telegram', tg],
    ]);
  }

  /**
   * Return the active provider for a channel on a tenant, or null if
   * the tenant has not enabled this channel. The check is against
   * `Tenant.features.multichannel.enabledChannels` (JSON).
   */
  async getProvider(tenantId: string, channel: ChatChannel): Promise<ChannelProvider | null> {
    if (!(await this.isChannelEnabled(tenantId, channel))) {
      return null;
    }
    return this.providers.get(channel) ?? null;
  }

  /**
   * Send via the registered provider. Returns null when the channel
   * is disabled so the dispatcher can decide whether to skip the
   * reply or fall back to a different channel.
   */
  async send(tenantId: string, channel: ChatChannel, args: {
    externalUserId: string;
    text: string;
    ctx: OutboundContext;
  }): Promise<SendResult | null> {
    const provider = await this.getProvider(tenantId, channel);
    if (!provider) {
      // Tenant is not entitled to this channel. Skip silently and
      // count it so dashboards can spot downgrade-related drop.
      this.metrics
        .counter(COUNTERS.CHANNEL_OUTBOUND, 'Outbound messages dispatched per channel')
        .inc({ channel, result: 'skipped' });
      return null;
    }
    try {
      const result = await provider.send(args);
      this.metrics
        .counter(COUNTERS.CHANNEL_OUTBOUND, 'Outbound messages dispatched per channel')
        .inc({ channel, result: 'ok' });
      return result;
    } catch (err) {
      this.metrics
        .counter(COUNTERS.CHANNEL_OUTBOUND, 'Outbound messages dispatched per channel')
        .inc({ channel, result: 'error' });
      throw err;
    }
  }

  /**
   * Read `Tenant.features.multichannel.enabledChannels`. Defaults to
   * `['web', 'whatsapp']` for tenants that haven't configured multichannel
   * yet (backward compatibility with the pre-H-4 deployment).
   */
  private async isChannelEnabled(tenantId: string, channel: ChatChannel): Promise<boolean> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { features: true },
    });
    if (!tenant) return false;
    const features = (tenant.features as any) ?? {};
    const mc = features.multichannel;
    // Default: only `web` is on (legacy behavior).
    if (!mc) return channel === 'web';
    if (mc.enabled === false) return channel === 'web';
    const enabled = (mc.enabledChannels as string[] | undefined) ?? ['web', 'whatsapp'];
    return enabled.includes(channel);
  }
}
