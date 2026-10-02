import { createHmac } from 'crypto';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { ChannelConnectionsService } from './channel-connections.service';

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
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

function setup(over: { env?: Record<string, string>; graph?: any; bot?: any; otherTenant?: string | null } = {}) {
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
  const credentials = {
    encrypt: (p: string) => `enc(${p})`,
    decrypt: (c: string) => c.replace(/^enc\((.*)\)$/, '$1'),
    read: jest.fn(async () => mc),
    update: jest.fn(async (_t: string, fn: any) => (mc = fn({ ...mc }))),
    meta: jest.fn(async () =>
      mc.meta ? { pageId: mc.meta.pageId, pageToken: mc.meta.pageAccessTokenEnc.slice(4, -1) } : null,
    ),
    telegram: jest.fn(async () => (mc.telegram ? { botToken: 'tok' } : null)),
    tenantForPage: jest.fn(async () => over.otherTenant ?? null),
  } as any;
  const graph = {
    isConfigured: () => true,
    buildLoginUrl: jest.fn((state: string, redirect: string) => `https://facebook.test/dialog?state=${state}&r=${redirect}`),
    exchangeCode: jest.fn(async () => ({ ok: true, data: { access_token: 'short' } })),
    longLivedUserToken: jest.fn(async () => ({ ok: true, data: { access_token: 'long' } })),
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
  const prisma = { tenant: { findFirst: jest.fn(async () => (over.otherTenant ? { id: over.otherTenant } : null)) } } as any;
  const svc = new ChannelConnectionsService(prisma, config, encryption, credentials, graph, bot);
  return { svc, graph, bot, mc: () => mc };
}

describe('ChannelConnectionsService: Meta', () => {
  it('builds the login URL with a signed state and the backend callback', () => {
    const { svc, graph } = setup();
    svc.metaLoginUrl(TENANT);
    const [state, redirect] = graph.buildLoginUrl.mock.calls[0];
    expect(redirect).toBe('https://api.example.test/api/v1/channels/meta/callback');
    expect(svc.verifyState(state)).toBe(TENANT);
  });

  it('rejects a tampered or expired state', () => {
    const { svc } = setup();
    const state = svc.signState(TENANT);
    expect(svc.verifyState(state.slice(0, -2) + 'aa')).toBeNull();
    expect(svc.verifyState(svc.signState(TENANT, Date.now() - 60 * 60 * 1000))).toBeNull();
  });

  it('connects the only Page: subscribes it, stores its token encrypted, turns on Messenger and Instagram', async () => {
    const { svc, graph, mc } = setup();
    expect(await svc.completeMetaLogin('code', svc.signState(TENANT))).toEqual({ tenantId: TENANT, outcome: 'connected' });
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
  });

  it('keeps several Pages (tokens encrypted) for the salon to choose, then connects the chosen one', async () => {
    const pages = [
      { id: '1', name: 'Uno', access_token: 'T1' },
      { id: '2', name: 'Dos', access_token: 'T2' },
    ];
    const { svc, graph, mc } = setup({ graph: { listPages: jest.fn(async () => ({ ok: true, data: { data: pages } })) } });
    expect((await svc.completeMetaLogin('code', svc.signState(TENANT))).outcome).toBe('choose');
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
    expect((await bad.svc.completeMetaLogin('x', bad.svc.signState(TENANT))).outcome).toBe('error');
    const none = setup({ graph: { listPages: jest.fn(async () => ({ ok: true, data: { data: [] } })) } });
    expect((await none.svc.completeMetaLogin('x', none.svc.signState(TENANT))).outcome).toBe('no_pages');
    expect((await none.svc.completeMetaLogin('x', 'forged.state')).outcome).toBe('error');
  });

  it('refuses a Page already connected to another salon', async () => {
    const { svc } = setup({ otherTenant: 'other-tenant' });
    await svc.completeMetaLogin('code', svc.signState(TENANT));
    await expect(
      (svc as any).connectPage(TENANT, { id: '1001', name: 'x', access_token: 't' }),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it('says plainly when KiraRoom\'s Meta app is not configured', () => {
    const { svc } = setup({ graph: { isConfigured: () => false } });
    expect(svc.availability()).toMatchObject({ meta: false, metaReason: 'meta_app_not_configured', telegram: true });
    expect(() => svc.metaLoginUrl(TENANT)).toThrow(BadRequestException);
  });

  it('disconnecting unsubscribes the Page and forgets it', async () => {
    const { svc, graph, mc } = setup();
    await svc.completeMetaLogin('code', svc.signState(TENANT));
    await svc.disconnectMeta(TENANT);
    expect(graph.unsubscribePage).toHaveBeenCalledWith('1001', 'PAGE_TOKEN');
    expect(mc().meta).toBeUndefined();
    expect(mc().enabledChannels).not.toContain('facebook');
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

  it('refuses a bot already connected to another salon', async () => {
    const { svc } = setup({ otherTenant: 'other-tenant' });
    await expect(svc.connectTelegram(TENANT, TOKEN)).rejects.toBeInstanceOf(ConflictException);
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
