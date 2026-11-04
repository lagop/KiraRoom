import { ConflictException, Injectable, Logger } from "@nestjs/common";
import { Prisma } from "@prisma/client";
import { PrismaService } from "../../common/prisma/prisma.service";
import { runUnscoped } from "../../common/tenancy/tenant.context";
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
 *
 * Which salon owns a Page, Instagram account or bot is also in the
 * channel_accounts table (ChannelAccount), unique per account: inbound
 * messages are routed by it, and claiming it is what stops two salons from
 * connecting the same one (a lookup by JSON path could not, and raced).
 */
export type AccountChannel = "facebook" | "instagram" | "telegram";
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
  tenantForPage(pageId: string): Promise<string | null> {
    return this.ownerOf("facebook", pageId);
  }

  /** The salon whose Instagram professional account received a message. */
  tenantForInstagram(instagramId: string): Promise<string | null> {
    return this.ownerOf("instagram", instagramId);
  }

  /** The salon an account is connected to, whoever asks (unscoped: it is about other salons too). */
  async ownerOf(channel: AccountChannel, externalId: string): Promise<string | null> {
    const row = await runUnscoped(() =>
      this.prisma.channelAccount.findUnique({
        where: { channel_externalId: { channel, externalId: String(externalId) } },
        select: { tenantId: true },
      }),
    );
    return row?.tenantId ?? null;
  }

  /**
   * Claims an account for the salon (replacing the salon's previous one on
   * that channel), or throws a ConflictException with `conflictMessage` when
   * another salon holds it, including one that claims it at the same moment
   * (the unique index decides). Returns an undo that puts the salon's
   * previous claim back, for when the connection fails afterwards.
   */
  async claim(tenantId: string, channel: AccountChannel, externalId: string, conflictMessage: string): Promise<() => Promise<void>> {
    const id = String(externalId);
    const owner = await this.ownerOf(channel, id);
    if (owner && owner !== tenantId) throw new ConflictException(conflictMessage);
    const previous = await this.prisma.channelAccount.findUnique({
      where: { tenantId_channel: { tenantId, channel } },
      select: { externalId: true },
    });
    try {
      await this.prisma.channelAccount.upsert({
        where: { tenantId_channel: { tenantId, channel } },
        create: { tenantId, channel, externalId: id },
        // A new connection: the old token's problems no longer apply.
        update: { externalId: id, authErrorAt: null, authError: null, attentionNotifiedAt: null },
      });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ConflictException(conflictMessage);
      }
      throw err;
    }
    return async () => {
      try {
        if (previous) {
          await this.prisma.channelAccount.update({
            where: { tenantId_channel: { tenantId, channel } },
            data: { externalId: previous.externalId },
          });
        } else {
          await this.prisma.channelAccount.deleteMany({ where: { tenantId, channel } });
        }
      } catch (err) {
        this.logger.warn(`Could not undo the ${channel} claim of tenant ${tenantId}: ${(err as Error).message}`);
      }
    };
  }

  /** Forgets the salon's accounts on these channels (disconnect). */
  async release(tenantId: string, channels: AccountChannel[]): Promise<void> {
    await this.prisma.channelAccount.deleteMany({ where: { tenantId, channel: { in: channels } } });
  }

  /** Whether Meta / Telegram refused the salon's tokens (for the settings page). */
  async accessLost(tenantId: string): Promise<{ facebook: boolean; telegram: boolean }> {
    const rows = await this.prisma.channelAccount.findMany({
      where: { tenantId, channel: { in: ["facebook", "telegram"] }, authErrorAt: { not: null } },
      select: { channel: true },
    });
    return {
      facebook: rows.some((r) => r.channel === "facebook"),
      telegram: rows.some((r) => r.channel === "telegram"),
    };
  }
}
