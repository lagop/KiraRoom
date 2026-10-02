import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import { ChannelsConfigView } from '@kira/shared';

/** The switches the settings page can change directly. */
export interface ChannelsSwitches {
  enabled?: boolean;
  enabledChannels?: string[];
}

/**
 * P2A-receptionist-v2 H-4: read / update the tenant's multichannel
 * configuration stored on `Tenant.features.multichannel.*` (JSON).
 *
 * Only the on/off switches are written here. Credentials are set by
 * ChannelConnectionsService (Facebook Login, Telegram's getMe/setWebhook)
 * and stored encrypted; this endpoint used to merge whatever the request
 * body held into the JSON, tokens included, in clear text.
 *
 * Secrets are never returned: the view says whether each channel is
 * connected and to which Page / Instagram account / bot.
 */
@Injectable()
export class ChannelsConfigService {
  private readonly logger = new Logger(ChannelsConfigService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getConfig(tenantId: string): Promise<ChannelsConfigView> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { features: true },
    });
    if (!tenant) {
      throw new Error(`Tenant ${tenantId} not found`);
    }
    return this.toView((tenant.features as any) ?? {});
  }

  async updateConfig(tenantId: string, dto: ChannelsSwitches): Promise<ChannelsConfigView> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { features: true },
    });
    if (!tenant) {
      throw new Error(`Tenant ${tenantId} not found`);
    }
    const currentFeatures = (tenant.features as any) ?? {};
    const next = { ...(currentFeatures.multichannel ?? {}) };

    if (dto.enabledChannels !== undefined) {
      // `web` is the always-on channel.
      const set = new Set(dto.enabledChannels);
      set.add('web');
      next.enabledChannels = Array.from(set);
    }
    next.enabled = dto.enabled ?? next.enabled ?? true;

    const nextFeatures = { ...currentFeatures, multichannel: next };
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { features: nextFeatures as any },
    });
    this.logger.log(
      `Updated multichannel config for tenant ${tenantId}: channels=${(next.enabledChannels ?? []).join(',')}`,
    );
    return this.toView(nextFeatures);
  }

  private toView(features: Record<string, any>): ChannelsConfigView {
    const mc = features.multichannel ?? {};
    const enabledChannels: string[] = Array.isArray(mc.enabledChannels)
      ? mc.enabledChannels
      : ['web', 'whatsapp'];
    const meta = mc.meta;
    const telegram = mc.telegram;
    const pendingValid =
      !!mc.metaPending && new Date(mc.metaPending.expiresAt).getTime() > Date.now();

    return {
      enabled: mc.enabled !== false,
      enabledChannels,
      meta: meta
        ? {
            configured: !!meta.pageId && !!(meta.pageAccessTokenEnc || meta.pageAccessToken),
            pageId: meta.pageId,
            pageName: meta.pageName,
            instagramBusinessAccountId: meta.instagramBusinessAccountId,
            instagramUsername: meta.instagramUsername,
            hasAccessToken: !!(meta.pageAccessTokenEnc || meta.pageAccessToken),
            // Pages saved by the first version (token pasted in a form) were
            // never subscribed to the webhook: they must be connected again.
            needsReconnect: !meta.pageAccessTokenEnc,
          }
        : null,
      metaPagesPending: pendingValid,
      telegram: telegram
        ? {
            configured: !!(telegram.botTokenEnc || telegram.botToken),
            botUsername: telegram.botUsername,
            hasBotToken: !!(telegram.botTokenEnc || telegram.botToken),
            // Bots configured by the first version never had their webhook
            // registered: they must be connected again.
            needsReconnect: !telegram.botTokenEnc,
          }
        : null,
    };
  }
}
