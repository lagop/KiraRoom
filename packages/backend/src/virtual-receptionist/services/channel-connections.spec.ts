import { createHmac } from 'crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ChannelConnectionsService, INSTAGRAM_TAKEN } from './channel-connections.service';
import { RedisService } from '../../common/cache/redis.service';

/**
 * Connecting a salon's Facebook Page and Telegram bot.
 *
 * The first version stored a pasted Page token, webhook secret and bot
 * token in clear text and never told Meta or Telegram where to deliver, so
 * nothing ever arrived. Now: Facebook Login -> long-lived token -> the
 * salon's Pages -> the chosen Page is subscribed to the webhook and its
 * token stored encrypted; the bot token is checked with getMe, the webhook
 * registered with a fresh secret, and the token stored encrypted. Meta and
 * Telegram are mocked.
 *
 * Channels audit: the login is bound to the browser and user that started
 * it (M6), the Page and its Instagram account are claimed in a unique table
 * (M13), and a failed login says why (M14).
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const USER = 'user-1';

function setup(
  over: {
    env?: Record<string, string>;
    graph?: any;
    bot?: any;
    /** Accounts other salons hold: "facebook:1001" -> tenant. */
    taken?: Record<string, string>;
  } = {},
) {
  const env: Record<string, string> = {
    API_BASE_URL: 'https://api.example.test',
    FRONTEND_URL: 'https://app.example.test',
    OAUTH_STATE_SECRET: 'state-secret-0123456789',
    ...(over.env ?? {}),
  };
  const config = { get: (k: string) => env[k] } as any;
  const encryption = {
    hmac: (v: string, s: string) => createHmac('sha256', s).update(v).digest('hex'),
  } as any;
  let mc: Record<string, any> = {};
  // channel_accounts: "channel:externalId" -> tenant
  const accounts = new Map<string, string>(Object.entries(over.taken ?? {}));
  const credentials = {
    encrypt: (p: string) => `enc(${p})`,
    decrypt: (c: string) => c.replace(/^enc\((.*)\)$/, '$1'),
    read: jest.fn(async () => mc),
    update: jest.fn(async (_t: string, fn: any) => (mc = fn({ ...mc }))),
    meta: jest.fn(async () =>
      mc.meta ? { pageId: mc.meta.pageId, pageToken: mc.meta.pageAccessTokenEnc.slice(4, -1) } : null,
    ),
    telegram: jest.fn(async () => (mc.telegram ? { botToken: 'tok' } : null)),
    claim: jest.fn(async (tenantId: string, channel: string, id: string, message: string) => {
      const key = `${channel}:${id}`;
      const owner = accounts.get(key);
      if (owner && owner !== tenantId) throw new ConflictException(message);
      const previous = [...accounts.entries()].find(([k, t]) => t === tenantId && k.startsWith(`${channel}:`));
      if (previous) accounts.delete(previous[0]);
      accounts.set(key, tenantId);
      return async () => {
        accounts.delete(key);
        if (previous) accounts.set(previous[0], previous[1]);
      };
    }),
    release: jest.fn(async (tenantId: string, channels: string[]) => {
      for (const [k, t] of [...accounts.entries()]) if (t === tenantId && channels.includes(k.split(':')[0])) accounts.delete(k);
    }),
  } as any;
  const graph = {
    isConfigured: () => true,
    buildLoginUrl: jest.fn((state: string, redirect: string) => `https://facebook.test/dialog?state=${state}&r=${redirect}`),
    exchangeCode: jest.fn(async () => ({ ok: true, data: { access_token: 'short' } })),
    longLivedUserToken: jest.fn(async () => ({ ok: true, data: { access_token: 'long' } })),
    listPermissions: jest.fn(async () => ({
      ok: true,
      data: {
        data: [
          { permission: 'pages_messaging', status: 'granted' },
          { permission: 'instagram_manage_messages', status: 'granted' },
        ],
      },
    })),
    listPages: jest.fn(async () => ({
      ok: true,
      data: { data: [{ id: '1001', name: 'Salón Lucía', access_token: 'PAGE_TOKEN', instagram_business_account: { id: '1789', username: 'salonlucia' } }] },
    })),
    subscribePage: jest.fn(async () => ({ ok: true, data: { success: true } })),
    unsubscribePage: jest.fn(async () => ({ ok: true })),
    ...(over.graph ?? {}),
  } as any;
  const bot = {
    getMe: jest.fn(async () => ({ ok: true, result: { id: 42, is_bot: true, username: 'salon_bot', first_name: 'Salón' } })),
    setWebhook: jest.fn(async () => ({ ok: true, result: true })),
    deleteWebhook: jest.fn(async () => ({ ok: true, result: true })),
    ...(over.bot ?? {}),
  } as any;
  const prisma = {} as any;
  const redis = new RedisService({ get: () => undefined } as any);
  const svc = new ChannelConnectionsService(prisma, config, encryption, credentials, graph, bot, redis);
  /** What the panel's GET meta/connect hands the browser: the state (in the URL) and the cookie's nonce. */
  const start = () => {
    const { url, nonce } = svc.startMetaLogin(TENANT, USER);
    const state = decodeURIComponent(/state=([^&]+)/.exec(url)![1]);
    return { state, nonce };
  };
  const login = async (code = 'code') => {
    const { state, nonce } = start();
    return svc.completeMetaLogin(code, state, nonce);
  };
  return { svc, graph, bot, credentials, mc: () => mc, accounts, start, login };
}

describe('ChannelConnectionsService: Meta', () => {
  it('builds the login URL with a signed state (salon, user, nonce hash) and the backend callback', () => {
    const { svc, graph } = setup();
    const { nonce } = svc.startMetaLogin(TENANT, USER);
    const [state, redirect] = graph.buildLoginUrl.mock.calls[0];
    expect(redirect).toBe('https://api.example.test/api/v1/channels/meta/callback');
    expect(svc.verifyState(state)).toMatchObject({ tenantId: TENANT, userId: USER });
    // The nonce itself never travels in the URL, only its hash.
    expect(state).not.toContain(nonce);
    expect(nonce.length).toBeGreaterThanOrEqual(40);
  });

  it('rejects a tampered or expired state', () => {
    const { svc } = setup();
    const state = svc.signState(TENANT, USER, 'n');
    // Swap the last character for a different one: a fixed 'aa' was the real
    // signature now and then, which made this test fail at random.
    const last = state.slice(-1);
    expect(svc.verifyState(state.slice(0, -1) + (last === 'a' ? 'b' : 'a'))).toBeNull();
    expect(svc.verifyState(svc.signState(TENANT, USER, 'n', Date.now() - 60 * 60 * 1000))).toBeNull();
  });

  it('a login link opened in another browser (no nonce cookie, or another one) connects nothing (M6)', async () => {
    const { svc, graph, start } = setup();
    const { state } = start();
    expect(await svc.completeMetaLogin('code', state, undefined)).toEqual({ tenantId: null, outcome: 'session' });
    expect(await svc.completeMetaLogin('code', state, 'someone-elses-nonce')).toEqual({ tenantId: null, outcome: 'session' });
    expect(graph.exchangeCode).not.toHaveBeenCalled();
  });

  it('a state can be used once (M6)', async () => {
    const { svc, graph, start } = setup();
    const { state, nonce } = start();
    expect((await svc.completeMetaLogin('code', state, nonce)).outcome).toBe('connected');
    expect(await svc.completeMetaLogin('code', state, nonce)).toEqual({ tenantId: null, outcome: 'session' });
    expect(graph.exchangeCode).toHaveBeenCalledTimes(1);
  });

  it('connects the only Page: subscribes it, stores its token encrypted, turns on Messenger and Instagram', async () => {
    const { svc, graph, mc, login, accounts } = setup();
    expect(await login()).toEqual({ tenantId: TENANT, outcome: 'connected' });
    expect(graph.longLivedUserToken).toHaveBeenCalledWith('short');
    expect(graph.listPages).toHaveBeenCalledWith('long');
    expect(graph.subscribePage).toHaveBeenCalledWith('1001', 'PAGE_TOKEN');
    expect(mc().meta).toMatchObject({
      pageId: '1001',
      pageName: 'Salón Lucía',
      instagramBusinessAccountId: '1789',
      instagramUsername: 'salonlucia',
      pageAccessTokenEnc: 'enc(PAGE_TOKEN)',
    });
    expect(JSON.stringify(mc())).not.toContain('"PAGE_TOKEN"');
    expect(mc().enabledChannels).toEqual(expect.arrayContaining(['web', 'facebook', 'instagram']));
    expect(svc).toBeDefined();
    // Claimed in channel_accounts, which routes the inbound messages.
    expect(accounts.get('facebook:1001')).toBe(TENANT);
    expect(accounts.get('instagram:1789')).toBe(TENANT);
  });

  it('keeps several Pages (tokens encrypted) for the salon to choose, then connects the chosen one', async () => {
    const pages = [
      { id: '1', name: 'Uno', access_token: 'T1' },
      { id: '2', name: 'Dos', access_token: 'T2' },
    ];
    const { svc, graph, mc, login } = setup({ graph: { listPages: jest.fn(async () => ({ ok: true, data: { data: pages } })) } });
    expect((await login()).outcome).toBe('choose');
    expect(await svc.pendingPages(TENANT)).toEqual([{ id: '1', name: 'Uno' }, { id: '2', name: 'Dos' }]);
    expect(JSON.stringify(mc().metaPending)).not.toMatch(/"T1"|"T2"/);
    await svc.selectPage(TENANT, '2');
    expect(graph.subscribePage).toHaveBeenCalledWith('2', 'T2');
    expect(mc().meta.pageId).toBe('2');
    expect(mc().metaPending).toBeUndefined();
    expect(mc().enabledChannels).not.toContain('instagram');
  });

  it('reports a login whose code cannot be exchanged, or an account with no Pages', async () => {
    const bad = setup({ graph: { exchangeCode: jest.fn(async () => ({ ok: false, error: { message: 'bad code' } })) } });
    expect((await bad.login('x')).outcome).toBe('error');
    const none = setup({ graph: { listPages: jest.fn(async () => ({ ok: true, data: { data: [] } })) } });
    expect((await none.login('x')).outcome).toBe('no_pages');
    expect((await none.svc.completeMetaLogin('x', 'forged.state', 'n')).outcome).toBe('session');
  });

  it('says why when the Page is another salon\'s, keeping nothing (M13, M14)', async () => {
    const { login, graph, mc } = setup({ taken: { 'facebook:1001': 'other-tenant' } });
    expect((await login()).outcome).toBe('page_taken');
    expect(graph.subscribePage).not.toHaveBeenCalled();
    expect(mc().meta).toBeUndefined();
  });

  it('says why when Meta refuses to subscribe the Page, and gives the claim back (M14)', async () => {
    const { login, accounts, mc } = setup({
      graph: { subscribePage: jest.fn(async () => ({ ok: false, error: { message: 'no permission' } })) },
    });
    expect((await login()).outcome).toBe('subscribe_failed');
    expect(accounts.size).toBe(0);
    expect(mc().meta).toBeUndefined();
  });

  it('says why when pages_messaging was not granted (M14)', async () => {
    const { login, graph } = setup({
      graph: { listPermissions: jest.fn(async () => ({ ok: true, data: { data: [{ permission: 'pages_messaging', status: 'declined' }] } })) },
    });
    expect((await login()).outcome).toBe('missing_permissions');
    expect(graph.listPages).not.toHaveBeenCalled();
  });

  it('connects Messenger without an Instagram account another salon holds, and says so (M13)', async () => {
    const { login, svc, mc, accounts } = setup({ taken: { 'instagram:1789': 'other-tenant' } });
    expect((await login()).outcome).toBe('instagram_taken');
    expect(mc().meta.pageId).toBe('1001');
    expect(mc().meta.instagramBusinessAccountId).toBeUndefined();
    expect(mc().enabledChannels).not.toContain('instagram');
    expect(accounts.get('instagram:1789')).toBe('other-tenant');
    expect(INSTAGRAM_TAKEN).toMatch(/hemos conectado solo Messenger/);
    expect(svc).toBeDefined();
  });

  it('refuses a Page another salon holds when picked from the list too', async () => {
    const { svc } = setup({ taken: { 'facebook:1001': 'other-tenant' } });
    await expect(
      (svc as any).connectPage(TENANT, { id: '1001', name: 'x', access_token: 't' }),
    ).rejects.toMatchObject({ outcome: 'page_taken', status: 409 });
  });

  it('says plainly when KiraRoom\'s Meta app is not configured', () => {
    const { svc } = setup({ graph: { isConfigured: () => false } });
    expect(svc.availability()).toMatchObject({ meta: false, metaReason: 'meta_app_not_configured', telegram: true });
    expect(() => svc.startMetaLogin(TENANT, USER)).toThrow(BadRequestException);
  });

  it('disconnecting unsubscribes the Page and forgets it', async () => {
    const { svc, graph, mc, login, accounts } = setup();
    await login();
    await svc.disconnectMeta(TENANT);
    expect(graph.unsubscribePage).toHaveBeenCalledWith('1001', 'PAGE_TOKEN');
    expect(mc().meta).toBeUndefined();
    expect(mc().enabledChannels).not.toContain('facebook');
    expect(accounts.size).toBe(0);
  });
});

describe('ChannelConnectionsService: Telegram', () => {
  const TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef_-';

  it('checks the token, registers the webhook with a fresh secret and stores the token encrypted', async () => {
    const { svc, bot, mc } = setup();
    expect(await svc.connectTelegram(TENANT, TOKEN)).toEqual({ connected: true, botUsername: 'salon_bot' });
    expect(bot.getMe).toHaveBeenCalledWith(TOKEN);
    const [token, url, secret] = bot.setWebhook.mock.calls[0];
    expect(token).toBe(TOKEN);
    expect(url).toBe(`https://api.example.test/api/v1/channels/webhooks/telegram/${TENANT}`);
    expect(secret).toMatch(/^[a-f0-9]{64}$/);
    expect(mc().telegram).toMatchObject({ botId: '42', botUsername: 'salon_bot', botTokenEnc: `enc(${TOKEN})`, webhookSecret: secret });
    expect(mc().enabledChannels).toContain('telegram');
  });

  it('refuses a token Telegram does not recognise, without registering anything', async () => {
    const { svc, bot } = setup({ bot: { getMe: jest.fn(async () => ({ ok: false, description: 'Unauthorized' })) } });
    await expect(svc.connectTelegram(TENANT, TOKEN)).rejects.toBeInstanceOf(BadRequestException);
    expect(bot.setWebhook).not.toHaveBeenCalled();
  });

  it('refuses a bot already connected to another salon, without pointing its webhook here', async () => {
    const { svc, bot } = setup({ taken: { 'telegram:42': 'other-tenant' } });
    await expect(svc.connectTelegram(TENANT, TOKEN)).rejects.toBeInstanceOf(ConflictException);
    expect(bot.setWebhook).not.toHaveBeenCalled();
  });

  it('gives the bot claim back when Telegram refuses the webhook', async () => {
    const { svc, accounts } = setup({ bot: { setWebhook: jest.fn(async () => ({ ok: false, description: 'bad url' })) } });
    await expect(svc.connectTelegram(TENANT, TOKEN)).rejects.toBeInstanceOf(BadRequestException);
    expect(accounts.size).toBe(0);
  });

  it('is unavailable, and says so, without the server\'s public address', async () => {
    const { svc } = setup({ env: { API_BASE_URL: '' } });
    expect(svc.availability()).toMatchObject({ telegram: false, telegramReason: 'api_base_url_missing' });
    await expect(svc.connectTelegram(TENANT, TOKEN)).rejects.toThrow(/API_BASE_URL/);
  });

  it('disconnecting deletes the webhook and forgets the bot', async () => {
    const { svc, bot, mc } = setup();
    await svc.connectTelegram(TENANT, TOKEN);
    await svc.disconnectTelegram(TENANT);
    expect(bot.deleteWebhook).toHaveBeenCalledWith('tok');
    expect(mc().telegram).toBeUndefined();
    expect(mc().enabledChannels).not.toContain('telegram');
  });
});
