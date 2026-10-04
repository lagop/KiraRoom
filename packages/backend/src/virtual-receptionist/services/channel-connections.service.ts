import { BadRequestException, ConflictException, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { ChannelCredentialsService } from '../channels/channel-credentials.service';
import { ManagedPage, MetaGraphClient } from '../channels/meta-graph.client';
import { TelegramBotClient } from '../channels/telegram-bot.client';

const STATE_TTL_MS = 15 * 60 * 1000;
const PENDING_TTL_MS = 30 * 60 * 1000;
const BOT_TOKEN = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;

export type MetaLoginOutcome = 'connected' | 'choose' | 'no_pages' | 'error';

/**
 * Connecting a salon's own Facebook Page (Messenger + the Instagram account
 * linked to it) and its own Telegram bot.
 *
 * The first version asked the salon to paste a Page access token, a webhook
 * secret and a bot token into a form, stored them in clear text, and never
 * told Meta or Telegram where to deliver messages, so nothing arrived:
 *
 * - Meta: the salon signs in with Facebook (KiraRoom's Meta app), KiraRoom
 *   lists the Pages it manages, and the chosen Page is subscribed to the
 *   app's webhook (POST /{page}/subscribed_apps). Its Page token -- which
 *   does not expire when it comes from a long-lived user token -- is stored
 *   encrypted. Messages then arrive at /channels/webhooks/meta, signed with
 *   the app secret.
 * - Telegram: the salon pastes the token @BotFather gave it. KiraRoom checks
 *   it with getMe, registers its webhook with setWebhook and a fresh
 *   secret_token, and stores the token encrypted.
 */
@Injectable()
export class ChannelConnectionsService {
  private readonly logger = new Logger(ChannelConnectionsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly encryption: EncryptionService,
    private readonly credentials: ChannelCredentialsService,
    private readonly graph: MetaGraphClient,
    private readonly bot: TelegramBotClient,
  ) {}

  // ---- Where things are -------------------------------------------------

  /**
   * The backend's public origin (API_BASE_URL, e.g. https://api.kiraroom.net):
   * Meta's login redirect and Telegram's webhook must reach the backend
   * itself, and the app domain does not proxy /api.
   */
  apiBase(): string | null {
    const raw = this.config.get<string>('API_BASE_URL')?.trim();
    if (!raw) return null;
    return raw.replace(/\/+$/, '').replace(/\/api\/v1$/, '');
  }

  frontendBase(): string {
    return (
      this.config.get<string>('FRONTEND_BASE_URL') ||
      this.config.get<string>('FRONTEND_URL') ||
      this.config.get<string>('APP_BASE_URL') ||
      'http://localhost:3000'
    ).replace(/\/+$/, '');
  }

  metaRedirectUri(): string | null {
    const base = this.apiBase();
    return base ? `${base}/api/v1/channels/meta/callback` : null;
  }

  /** What the settings page can offer, and why not when it cannot. */
  availability(): { meta: boolean; metaReason?: string; telegram: boolean; telegramReason?: string } {
    const base = this.apiBase();
    return {
      meta: this.graph.isConfigured() && !!base,
      metaReason: !this.graph.isConfigured()
        ? 'meta_app_not_configured'
        : !base
          ? 'api_base_url_missing'
          : undefined,
      telegram: !!base,
      telegramReason: base ? undefined : 'api_base_url_missing',
    };
  }

  // ---- Meta (Messenger + Instagram) ------------------------------------

  /** The Facebook Login URL the salon is sent to. */
  metaLoginUrl(tenantId: string): string {
    const redirect = this.metaRedirectUri();
    if (!this.graph.isConfigured() || !redirect) {
      throw new BadRequestException(
        'Messenger e Instagram todavía no están disponibles: falta configurar la app de Meta de KiraRoom.',
      );
    }
    return this.graph.buildLoginUrl(this.signState(tenantId), redirect);
  }

  /**
   * Finishes Facebook Login: exchanges the code, lists the salon's Pages and
   * connects the only one, or keeps them for the salon to choose.
   */
  async completeMetaLogin(code: string, state: string): Promise<{ tenantId: string | null; outcome: MetaLoginOutcome }> {
    const tenantId = this.verifyState(state);
    if (!tenantId) return { tenantId: null, outcome: 'error' };
    const redirect = this.metaRedirectUri();
    if (!redirect) return { tenantId, outcome: 'error' };

    const short = await this.graph.exchangeCode(code, redirect);
    if (!short.ok || !short.data?.access_token) {
      this.logger.warn(`Meta code exchange failed for tenant ${tenantId}: ${short.error?.message}`);
      return { tenantId, outcome: 'error' };
    }
    // Page tokens obtained with a long-lived user token do not expire; with
    // the short-lived one they would stop working within hours.
    const long = await this.graph.longLivedUserToken(short.data.access_token);
    if (!long.ok || !long.data?.access_token) {
      this.logger.warn(`Meta long-lived token exchange failed for tenant ${tenantId}: ${long.error?.message}`);
      return { tenantId, outcome: 'error' };
    }
    const pages = await this.graph.listPages(long.data.access_token);
    if (!pages.ok) {
      this.logger.warn(`Meta /me/accounts failed for tenant ${tenantId}: ${pages.error?.message}`);
      return { tenantId, outcome: 'error' };
    }
    const list = (pages.data?.data ?? []).filter((p) => p?.id && p?.access_token);
    if (list.length === 0) return { tenantId, outcome: 'no_pages' };
    if (list.length === 1) {
      try {
        await this.connectPage(tenantId, list[0]);
        return { tenantId, outcome: 'connected' };
      } catch (err) {
        this.logger.warn(`Connecting Page for tenant ${tenantId} failed: ${(err as Error).message}`);
        return { tenantId, outcome: 'error' };
      }
    }
    await this.credentials.update(tenantId, (mc) => ({
      ...mc,
      metaPending: {
        expiresAt: new Date(Date.now() + PENDING_TTL_MS).toISOString(),
        pages: list.map((p) => ({
          id: p.id,
          name: p.name,
          igId: p.instagram_business_account?.id,
          igUsername: p.instagram_business_account?.username,
          tokenEnc: this.credentials.encrypt(p.access_token),
        })),
      },
    }));
    return { tenantId, outcome: 'choose' };
  }

  /** Pages offered after Facebook Login, without their tokens. */
  async pendingPages(tenantId: string): Promise<Array<{ id: string; name: string; instagramUsername?: string }>> {
    const pending = (await this.credentials.read(tenantId)).metaPending;
    if (!pending || new Date(pending.expiresAt).getTime() < Date.now()) return [];
    return (pending.pages ?? []).map((p: any) => ({
      id: p.id,
      name: p.name,
      ...(p.igUsername ? { instagramUsername: p.igUsername } : {}),
    }));
  }

  async selectPage(tenantId: string, pageId: string) {
    const pending = (await this.credentials.read(tenantId)).metaPending;
    if (!pending || new Date(pending.expiresAt).getTime() < Date.now()) {
      throw new BadRequestException('La selección ha caducado. Vuelve a conectar con Facebook.');
    }
    const page = (pending.pages ?? []).find((p: any) => p.id === pageId);
    if (!page) throw new BadRequestException('Esa página no está entre las que autorizaste.');
    const token = this.credentials.decrypt(page.tokenEnc);
    if (!token) throw new BadRequestException('No se pudo leer el permiso de esa página. Vuelve a conectar con Facebook.');
    await this.connectPage(tenantId, {
      id: page.id,
      name: page.name,
      access_token: token,
      instagram_business_account: page.igId ? { id: page.igId, username: page.igUsername } : undefined,
    });
    return { connected: true };
  }

  async disconnectMeta(tenantId: string) {
    const creds = await this.credentials.meta(tenantId);
    if (creds) {
      const res = await this.graph.unsubscribePage(creds.pageId, creds.pageToken);
      if (!res.ok) this.logger.warn(`Unsubscribing Page for tenant ${tenantId} failed: ${res.error?.message}`);
    }
    await this.credentials.update(tenantId, (mc) => {
      const { meta: _m, metaPending: _p, ...rest } = mc;
      return {
        ...rest,
        enabledChannels: (mc.enabledChannels ?? ['web']).filter((c: string) => c !== 'facebook' && c !== 'instagram'),
      };
    });
    return { disconnected: true };
  }

  private async connectPage(tenantId: string, page: ManagedPage): Promise<void> {
    const other = await this.credentials.tenantForPage(page.id);
    if (other && other !== tenantId) {
      throw new ConflictException('Esta página de Facebook ya está conectada a otro salón de KiraRoom.');
    }
    const sub = await this.graph.subscribePage(page.id, page.access_token);
    if (!sub.ok) {
      throw new BadRequestException(
        `Meta no permitió recibir los mensajes de esta página: ${sub.error?.message ?? 'error desconocido'}`,
      );
    }
    const previous = await this.credentials.meta(tenantId);
    if (previous && previous.pageId !== page.id) {
      await this.graph.unsubscribePage(previous.pageId, previous.pageToken).catch(() => undefined);
    }
    const ig = page.instagram_business_account;
    await this.credentials.update(tenantId, (mc) => {
      const { metaPending: _p, ...rest } = mc;
      const channels = new Set<string>(mc.enabledChannels ?? ['web']);
      channels.add('web');
      channels.add('facebook');
      if (ig?.id) channels.add('instagram');
      else channels.delete('instagram');
      return {
        ...rest,
        enabled: true,
        enabledChannels: Array.from(channels),
        meta: {
          pageId: page.id,
          pageName: page.name,
          ...(ig?.id ? { instagramBusinessAccountId: ig.id } : {}),
          ...(ig?.username ? { instagramUsername: ig.username } : {}),
          pageAccessTokenEnc: this.credentials.encrypt(page.access_token),
          connectedAt: new Date().toISOString(),
        },
      };
    });
    this.logger.log(`Tenant ${tenantId} connected Facebook Page ${page.id}${ig?.id ? ' with Instagram' : ''}`);
  }

  // ---- Telegram ---------------------------------------------------------

  async connectTelegram(tenantId: string, botToken: string) {
    const token = (botToken ?? '').trim();
    if (!BOT_TOKEN.test(token)) {
      throw new BadRequestException('El token no tiene el formato que da @BotFather (números:letras).');
    }
    const base = this.apiBase();
    if (!base) {
      throw new BadRequestException(
        'Telegram todavía no está disponible: falta configurar la dirección pública del servidor (API_BASE_URL).',
      );
    }
    const me = await this.bot.getMe(token);
    if (!me.ok || !me.result?.is_bot) {
      throw new BadRequestException('Telegram no reconoce este token. Cópialo de nuevo desde @BotFather.');
    }
    const botId = String(me.result.id);
    const other = await this.prisma.tenant.findFirst({
      where: { features: { path: ['multichannel', 'telegram', 'botId'], equals: botId } },
      select: { id: true },
    });
    if (other && other.id !== tenantId) {
      throw new ConflictException('Este bot ya está conectado a otro salón de KiraRoom.');
    }
    // Telegram's secret_token accepts A-Z, a-z, 0-9, _ and -: hex fits.
    const secret = randomBytes(32).toString('hex');
    const hook = await this.bot.setWebhook(token, `${base}/api/v1/channels/webhooks/telegram/${tenantId}`, secret);
    if (!hook.ok) {
      throw new BadRequestException(`Telegram no aceptó la conexión: ${hook.description ?? 'error desconocido'}`);
    }
    await this.credentials.update(tenantId, (mc) => {
      const channels = new Set<string>(mc.enabledChannels ?? ['web']);
      channels.add('web');
      channels.add('telegram');
      return {
        ...mc,
        enabled: true,
        enabledChannels: Array.from(channels),
        telegram: {
          botId,
          botUsername: me.result!.username,
          botTokenEnc: this.credentials.encrypt(token),
          webhookSecret: secret,
          connectedAt: new Date().toISOString(),
        },
      };
    });
    this.logger.log(`Tenant ${tenantId} connected Telegram bot @${me.result.username}`);
    return { connected: true, botUsername: me.result.username };
  }

  async disconnectTelegram(tenantId: string) {
    const creds = await this.credentials.telegram(tenantId);
    if (creds) {
      const res = await this.bot.deleteWebhook(creds.botToken);
      if (!res.ok) this.logger.warn(`deleteWebhook for tenant ${tenantId} failed: ${res.description}`);
    }
    await this.credentials.update(tenantId, (mc) => {
      const { telegram: _t, ...rest } = mc;
      return { ...rest, enabledChannels: (mc.enabledChannels ?? ['web']).filter((c: string) => c !== 'telegram') };
    });
    return { disconnected: true };
  }

  // ---- OAuth state ------------------------------------------------------

  private stateSecret(): string {
    const secret = this.config.get<string>('OAUTH_STATE_SECRET');
    if (secret && secret.length >= 16) return secret;
    if (this.config.get<string>('NODE_ENV') === 'production') {
      throw new Error('OAUTH_STATE_SECRET must be set to a 16+ char random value in production');
    }
    return 'dev-oauth-secret-do-not-use-in-production';
  }

  /** `tenantId|expiry`, HMAC-signed: proves which salon started the login. */
  signState(tenantId: string, now = Date.now()): string {
    const payload = `${tenantId}|${now + STATE_TTL_MS}|meta-channels`;
    const b64 = Buffer.from(payload).toString('base64url');
    return `${b64}.${this.encryption.hmac(payload, this.stateSecret())}`;
  }

  verifyState(state: string, now = Date.now()): string | null {
    const [b64, sig] = (state ?? '').split('.');
    if (!b64 || !sig) return null;
    const payload = Buffer.from(b64, 'base64url').toString();
    const expected = Buffer.from(this.encryption.hmac(payload, this.stateSecret()));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
    const [tenantId, exp, purpose] = payload.split('|');
    if (purpose !== 'meta-channels' || !tenantId || Number(exp) < now) return null;
    return tenantId;
  }
}
