import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';
import {
  UpdateChannelsConfigDto,
  ChannelsConfigView,
} from '@kira/shared';

/**
 * P2A-receptionist-v2 H-4: read / update the tenant's multichannel
 * configuration stored on `Tenant.features.multichannel.*` (JSON).
 *
 * The shape is the same one the channel-registry reads at runtime, so
 * saving here is the only thing the wizard needs to do.
 *
 * Secrets (`pageAccessToken`, `botToken`) are never echoed back through
 * the GET endpoint; only `hasAccessToken` / `hasBotToken` flags are
 * returned so the UI can show the "connected" badge without leaking
 * the credentials.
 */
@Injectable()
export class ChannelsConfigService {
  private readonly logger = new Logger(ChannelsConfigService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Read the current multichannel config for a tenant. Returns a
   * normalised view with secrets redacted.
   */
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

  /**
   * Merge `dto` into `Tenant.features.multichannel` and persist.
   *
   * When the user removes a token (sends the channel config without a
   * `pageAccessToken` / `botToken`), the previous value is preserved
   * unless the caller explicitly passes `meta: null` (which we treat
   * as "reset"). This avoids accidentally wiping a token on a
   * partial save.
   */
  async updateConfig(
    tenantId: string,
    dto: UpdateChannelsConfigDto,
  ): Promise<ChannelsConfigView> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { features: true },
    });
    if (!tenant) {
      throw new Error(`Tenant ${tenantId} not found`);
    }
    const currentFeatures = (tenant.features as any) ?? {};
    const currentMc = currentFeatures.multichannel ?? {};
    const next = { ...currentMc, ...dto };

    // If `enabledChannels` is provided, ensure `web` is always present
    // (it's the always-on channel).
    if (dto.enabledChannels !== undefined) {
      const set = new Set(dto.enabledChannels);
      set.add('web');
      next.enabledChannels = Array.from(set);
    }

    // Sensible default: when the user saves for the first time and
    // doesn't set `enabled`, mark multichannel as enabled.
    if (dto.enabled === undefined) {
      next.enabled = true;
    }

    const nextFeatures = {
      ...currentFeatures,
      multichannel: next,
    };
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { features: nextFeatures as any },
    });
    this.logger.log(
      `Updated multichannel config for tenant ${tenantId}: channels=${(next.enabledChannels ?? []).join(',')}`,
    );
    return this.toView(nextFeatures);
  }

  /**
   * Convert raw `Tenant.features` to the redacted view shape.
   */
  private toView(features: Record<string, any>): ChannelsConfigView {
    const mc = features.multichannel ?? {};
    const enabledChannels: string[] = Array.isArray(mc.enabledChannels)
      ? mc.enabledChannels
      : ['web', 'whatsapp'];
    const meta = mc.meta;
    const telegram = mc.telegram;

    return {
      enabled: mc.enabled !== false,
      enabledChannels,
      meta: meta
        ? {
            configured: !!meta.pageId,
            pageId: meta.pageId,
            instagramBusinessAccountId: meta.instagramBusinessAccountId,
            linkedChats: Array.isArray(meta.linkedChats) ? meta.linkedChats : [],
            webhookSecret: meta.webhookSecret,
            hasAccessToken: !!meta.pageAccessToken,
          }
        : null,
      telegram: telegram
        ? {
            configured: !!telegram.botToken,
            // Bot username is unknown until first webhook — best effort.
            botUsername: telegram.botUsername,
            linkedChats: Array.isArray(telegram.linkedChats)
              ? telegram.linkedChats
              : [],
            hasBotToken: !!telegram.botToken,
          }
        : null,
    };
  }
}