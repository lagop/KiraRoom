import { Injectable, Logger } from "@nestjs/common";
import { PrismaService } from "../../common/prisma/prisma.service";
import { EncryptionService } from "../../common/encryption/encryption.service";

/**
 * How a salon's chat channels are stored, on `Tenant.features.multichannel`:
 *
 *   enabled, enabledChannels   which channels the receptionist answers on
 *   meta      { pageId, pageName, instagramBusinessAccountId,
 *               instagramUsername, pageAccessTokenEnc, connectedAt }
 *   metaPending { pages: [{ id, name, igId, igUsername, tokenEnc }], expiresAt }
 *               the Pages offered after Facebook Login, until one is chosen
 *   telegram  { botId, botUsername, botTokenEnc, webhookSecret, connectedAt }
 *
 * Tokens are encrypted (EncryptionService, the same key as the WhatsApp
 * token). The first version kept `pageAccessToken` / `botToken` in clear
 * text in this JSON; those are still read so a salon configured that way
 * keeps working, and they are dropped the next time it connects.
 */
export interface MetaCredentials {
  pageId: string;
  pageToken: string;
  instagramId?: string;
}

export interface TelegramCredentials {
  botToken: string;
  webhookSecret?: string;
  botId?: string;
}

@Injectable()
export class ChannelCredentialsService {
  private readonly logger = new Logger(ChannelCredentialsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  encrypt(plain: string): string {
    return this.encryption.encrypt(plain);
  }

  decrypt(cipher: string): string | null {
    try {
      return this.encryption.decrypt(cipher);
    } catch (err) {
      this.logger.error(`Could not decrypt a channel token: ${(err as Error).message}`);
      return null;
    }
  }

  async read(tenantId: string): Promise<Record<string, any>> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { features: true },
    });
    return ((tenant?.features as any)?.multichannel ?? {}) as Record<string, any>;
  }

  /** Read-modify-write of `features.multichannel`, keeping every other feature key. */
  async update(tenantId: string, mutate: (mc: Record<string, any>) => Record<string, any>): Promise<Record<string, any>> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { features: true },
    });
    if (!tenant) throw new Error(`Tenant ${tenantId} not found`);
    const features = ((tenant.features as any) ?? {}) as Record<string, any>;
    const next = mutate({ ...(features.multichannel ?? {}) });
    await this.prisma.tenant.update({
      where: { id: tenantId },
      data: { features: { ...features, multichannel: next } as any },
    });
    return next;
  }

  async meta(tenantId: string): Promise<MetaCredentials | null> {
    const meta = (await this.read(tenantId)).meta;
    if (!meta?.pageId) return null;
    const pageToken = meta.pageAccessTokenEnc
      ? this.decrypt(meta.pageAccessTokenEnc)
      : (meta.pageAccessToken as string | undefined) ?? null;
    if (!pageToken) return null;
    return { pageId: String(meta.pageId), pageToken, instagramId: meta.instagramBusinessAccountId };
  }

  async telegram(tenantId: string): Promise<TelegramCredentials | null> {
    const tg = (await this.read(tenantId)).telegram;
    if (!tg) return null;
    const botToken = tg.botTokenEnc ? this.decrypt(tg.botTokenEnc) : (tg.botToken as string | undefined) ?? null;
    if (!botToken) return null;
    return { botToken, webhookSecret: tg.webhookSecret, botId: tg.botId ? String(tg.botId) : undefined };
  }

  /** The salon whose Facebook Page received a Messenger message. */
  async tenantForPage(pageId: string): Promise<string | null> {
    const row = await this.prisma.tenant.findFirst({
      where: { features: { path: ["multichannel", "meta", "pageId"], equals: String(pageId) } },
      select: { id: true },
    });
    return row?.id ?? null;
  }

  /** The salon whose Instagram professional account received a message. */
  async tenantForInstagram(instagramId: string): Promise<string | null> {
    const row = await this.prisma.tenant.findFirst({
      where: {
        features: { path: ["multichannel", "meta", "instagramBusinessAccountId"], equals: String(instagramId) },
      },
      select: { id: true },
    });
    return row?.id ?? null;
  }
}
