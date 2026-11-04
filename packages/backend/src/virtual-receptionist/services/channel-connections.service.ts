import { BadRequestException, ConflictException, HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import { PrismaService } from '../../common/prisma/prisma.service';
import { EncryptionService } from '../../common/encryption/encryption.service';
import { RedisService } from '../../common/cache/redis.service';
import { ChannelCredentialsService } from '../channels/channel-credentials.service';
import { ManagedPage, MetaGraphClient } from '../channels/meta-graph.client';
import { TelegramBotClient } from '../channels/telegram-bot.client';

const STATE_TTL_MS = 15 * 60 * 1000;
const PENDING_TTL_MS = 30 * 60 * 1000;
const BOT_TOKEN = /^\d{6,12}:[A-Za-z0-9_-]{30,}$/;

/**
 * Where Facebook Login ends, as the `?meta=` the settings page explains.
 * The concrete reasons used to collapse into "error" and the generic
 * "Vuelve a intentarlo" (M14).
 */
export type MetaLoginOutcome =
  | 'connected'
  | 'connected_no_instagram_permission'
  | 'instagram_taken'
  | 'choose'
  | 'no_pages'
  | 'missing_permissions'
  | 'page_taken'
  | 'subscribe_failed'
  | 'session'
  | 'error';

export const PAGE_TAKEN = 'Esta página de Facebook ya está conectada a otro salón de KiraRoom.';
export const BOT_TAKEN = 'Este bot ya está conectado a otro salón de KiraRoom.';
/** Not shown as an error: the Page is connected, its Instagram is not. */
export const INSTAGRAM_TAKEN =
  'La cuenta de Instagram de esta página ya está conectada a otro salón de KiraRoom: hemos conectado solo Messenger.';

/** A failed Page connection, with the outcome the login callback reports. */
export class MetaConnectError extends HttpException {
  constructor(message: string, readonly outcome: MetaLoginOutcome, status: HttpStatus) {
    super(message, status);
  }
}

/** The cookie that binds a Facebook Login to the browser (and user) that started it. */
export const META_OAUTH_COOKIE = 'kr_meta_oauth';
export const META_OAUTH_COOKIE_PATH = '/api/v1/channels/meta/callback';
export const META_OAUTH_TTL_MS = STATE_TTL_MS;

function sha256(v: string): string {
  return createHash('sha256').update(v).digest('hex');
}

function sameText(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

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
    private readonly redis: RedisService,
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

  /**
   * The Facebook Login URL the salon is sent to, and the nonce for the
   * httpOnly cookie the controller sets on this (authenticated) response.
   *
   * The state used to carry only the salon and an expiry, and could be used
   * any number of times: an owner could send their login link to another
   * salon's owner, and if she accepted on Facebook her Page was connected
   * to the first salon. Now the state also names the user and the hash of
   * a random nonce that only the starting browser holds (the cookie); the
   * callback refuses it from any other browser, and only once.
   */
  startMetaLogin(tenantId: string, userId: string): { url: string; nonce: string } {
    const redirect = this.metaRedirectUri();
    if (!this.graph.isConfigured() || !redirect) {
      throw new BadRequestException(
        'Messenger e Instagram todavía no están disponibles: falta configurar la app de Meta de KiraRoom.',
      );
    }
    const nonce = randomBytes(32).toString('base64url');
    return { url: this.graph.buildLoginUrl(this.signState(tenantId, userId, nonce), redirect), nonce };
  }

  /**
   * Finishes Facebook Login: checks the state and the browser's nonce,
   * exchanges the code, lists the salon's Pages and connects the only one,
   * or keeps them for the salon to choose.
   */
  async completeMetaLogin(
    code: string,
    state: string,
    nonce: string | undefined,
  ): Promise<{ tenantId: string | null; outcome: MetaLoginOutcome }> {
    const st = this.verifyState(state);
    if (!st) return { tenantId: null, outcome: 'session' };
    const { tenantId } = st;
    if (!nonce || !sameText(sha256(nonce), st.nonceHash)) {
      this.logger.warn(`Meta login for tenant ${tenantId} refused: started in another browser`);
      return { tenantId: null, outcome: 'session' };
    }
    // Once: a replayed callback (same state) is refused.
    if (!(await this.redis.setIfAbsent(`meta-oauth:used:${st.nonceHash}`, '1', Math.ceil(STATE_TTL_MS / 1000)))) {
      return { tenantId: null, outcome: 'session' };
    }
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
    // What the person granted: without pages_messaging nothing can work;
    // without the Instagram permissions only Messenger can. Best effort.
    const perms = await this.graph.listPermissions(long.data.access_token);
    const granted = perms.ok
      ? new Set((perms.data?.data ?? []).filter((p) => p?.status === 'granted').map((p) => p.permission))
      : null;
    if (granted && !granted.has('pages_messaging')) return { tenantId, outcome: 'missing_permissions' };
    const noInstagramPermission = !!granted && !granted.has('instagram_manage_messages');

    const pages = await this.graph.listPages(long.data.access_token);
    if (!pages.ok) {
      this.logger.warn(`Meta /me/accounts failed for tenant ${tenantId}: ${pages.error?.message}`);
      return { tenantId, outcome: 'error' };
    }
    const list = (pages.data?.data ?? []).filter((p) => p?.id && p?.access_token);
    if (list.length === 0) return { tenantId, outcome: 'no_pages' };
    if (list.length === 1) {
      try {
        const { instagramTaken } = await this.connectPage(tenantId, list[0]);
        return {
          tenantId,
          outcome: instagramTaken
            ? 'instagram_taken'
            : noInstagramPermission && !list[0].instagram_business_account?.id
              ? 'connected_no_instagram_permission'
              : 'connected',
        };
      } catch (err) {
        this.logger.warn(`Connecting Page for tenant ${tenantId} failed: ${(err as Error).message}`);
        return { tenantId, outcome: err instanceof MetaConnectError ? err.outcome : 'error' };
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
    const { instagramTaken } = await this.connectPage(tenantId, {
      id: page.id,
      name: page.name,
      access_token: token,
      instagram_business_account: page.igId ? { id: page.igId, username: page.igUsername } : undefined,
    });
    return instagramTaken ? { connected: true, instagramTaken: true, message: INSTAGRAM_TAKEN } : { connected: true };
  }

  async disconnectMeta(tenantId: string) {
    const creds = await this.credentials.meta(tenantId);
    if (creds) {
      const res = await this.graph.unsubscribePage(creds.pageId, creds.pageToken);
      if (!res.ok) this.logger.warn(`Unsubscribing Page for tenant ${tenantId} failed: ${res.error?.message}`);
    }
    await this.credentials.release(tenantId, ['facebook', 'instagram']);
    await this.credentials.update(tenantId, (mc) => {
      const { meta: _m, metaPending: _p, ...rest } = mc;
      return {
        ...rest,
        enabledChannels: (mc.enabledChannels ?? ['web']).filter((c: string) => c !== 'facebook' && c !== 'instagram'),
      };
    });
    return { disconnected: true };
  }

  /**
   * Connects one Page: claims it (and its Instagram account) for the salon,
   * subscribes it to the webhook and stores its token encrypted.
   *
   * The claim is the unique ChannelAccount row: the old check (any salon
   * with this pageId in its JSON?) did not look at the Instagram account,
   * and two salons connecting at once could both pass it. An Instagram
   * account another salon holds is left out (Messenger still connects) and
   * reported, rather than routed to either salon at random.
   */
  private async connectPage(tenantId: string, page: ManagedPage): Promise<{ instagramTaken: boolean }> {
    let undoPage: () => Promise<void>;
    try {
      undoPage = await this.credentials.claim(tenantId, 'facebook', page.id, PAGE_TAKEN);
    } catch (err) {
      if (err instanceof ConflictException) throw new MetaConnectError(PAGE_TAKEN, 'page_taken', HttpStatus.CONFLICT);
      throw err;
    }
    let ig = page.instagram_business_account?.id ? page.instagram_business_account : undefined;
    let instagramTaken = false;
    let undoIg: (() => Promise<void>) | undefined;
    if (ig) {
      try {
        undoIg = await this.credentials.claim(tenantId, 'instagram', ig.id, INSTAGRAM_TAKEN);
      } catch (err) {
        if (!(err instanceof ConflictException)) {
          await undoPage();
          throw err;
        }
        instagramTaken = true;
        ig = undefined;
      }
    }
    const sub = await this.graph.subscribePage(page.id, page.access_token);
    if (!sub.ok) {
      await undoIg?.();
      await undoPage();
      throw new MetaConnectError(
        `Meta no permitió recibir los mensajes de esta página: ${sub.error?.message ?? 'error desconocido'}`,
        'subscribe_failed',
        HttpStatus.BAD_REQUEST,
      );
    }
    const previous = await this.credentials.meta(tenantId);
    if (previous && previous.pageId !== page.id) {
      await this.graph.unsubscribePage(previous.pageId, previous.pageToken).catch(() => undefined);
    }
    if (!ig) await this.credentials.release(tenantId, ['instagram']);
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
    return { instagramTaken };
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
    // Claimed before its webhook is pointed here: a bot another salon holds
    // (or claims at the same moment) is refused without touching it.
    const undo = await this.credentials.claim(tenantId, 'telegram', botId, BOT_TAKEN);
    // Telegram's secret_token accepts A-Z, a-z, 0-9, _ and -: hex fits.
    const secret = randomBytes(32).toString('hex');
    const hook = await this.bot.setWebhook(token, `${base}/api/v1/channels/webhooks/telegram/${tenantId}`, secret);
    if (!hook.ok) {
      await undo();
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
    await this.credentials.release(tenantId, ['telegram']);
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

  /**
   * `tenantId|userId|expiry|sha256(nonce)`, HMAC-signed: which salon and
   * which user started the login, until when, and the browser that holds
   * the nonce (in the httpOnly cookie).
   */
  signState(tenantId: string, userId: string, nonce: string, now = Date.now()): string {
    const payload = `${tenantId}|${userId}|${now + STATE_TTL_MS}|${sha256(nonce)}|meta-channels`;
    const b64 = Buffer.from(payload).toString('base64url');
    return `${b64}.${this.encryption.hmac(payload, this.stateSecret())}`;
  }

  verifyState(state: string, now = Date.now()): { tenantId: string; userId: string; nonceHash: string } | null {
    const [b64, sig] = (state ?? '').split('.');
    if (!b64 || !sig) return null;
    const payload = Buffer.from(b64, 'base64url').toString();
    if (!sameText(this.encryption.hmac(payload, this.stateSecret()), sig)) return null;
    const [tenantId, userId, exp, nonceHash, purpose] = payload.split('|');
    if (purpose !== 'meta-channels' || !tenantId || !userId || !nonceHash || Number(exp) < now) return null;
    return { tenantId, userId, nonceHash };
  }
}
