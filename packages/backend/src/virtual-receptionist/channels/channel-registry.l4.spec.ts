import { ChannelRegistry } from './channel.registry';
import { WebChannelProvider } from './web-channel.provider';
import { FacebookMessengerProvider } from './facebook-messenger.provider';
import { InstagramChannelProvider } from './instagram-channel.provider';
import { TelegramChannelProvider } from './telegram-channel.provider';
import { MetaGraphClient } from './meta-graph.client';
import { TelegramBotClient } from './telegram-bot.client';

/**
 * L-4 specs: ChannelRegistry and the Messenger / Instagram / Telegram
 * providers, with `fetch` mocked so nothing reaches Meta or Telegram.
 *
 * The providers used to read the Page token in clear text, post to
 * /me/messages for Messenger, and expect the Telegram bot token in an
 * outbound context nothing filled, so no reply ever went out. They now
 * take the decrypted credentials of the salon, use the documented
 * endpoints, send plain text (these apps show Markdown literally) and split
 * long answers under each app's limit.
 */

const originalFetch = (globalThis as any).fetch;
type Call = { url: string; body: any; method?: string };
function mockFetch(responses: Array<{ ok?: boolean; status?: number; json: any }>): Call[] {
  const calls: Call[] = [];
  let i = 0;
  (globalThis as any).fetch = jest.fn(async (url: any, init?: any) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : undefined, method: init?.method });
    const r = responses[Math.min(i++, responses.length - 1)];
    return { ok: r.ok ?? true, status: r.status ?? 200, statusText: 'x', json: async () => r.json };
  });
  return calls;
}
afterEach(() => {
  (globalThis as any).fetch = originalFetch;
});

const config = { get: (k: string) => (k === 'META_API_VERSION' ? 'v21.0' : undefined) } as any;
const graph = new MetaGraphClient(config);
const bot = new TelegramBotClient();

function credentials(over: { meta?: any; telegram?: any } = {}) {
  return {
    meta: jest.fn(async () =>
      over.meta === undefined ? { pageId: '1001', pageToken: 'PAGE_TOKEN', instagramId: '1789' } : over.meta,
    ),
    telegram: jest.fn(async () =>
      over.telegram === undefined ? { botToken: '123456:BOT', webhookSecret: 's' } : over.telegram,
    ),
  } as any;
}

function makePrisma(tenantFeatures: any = {}) {
  return {
    tenant: { findUnique: jest.fn(async () => ({ id: 't-1', features: tenantFeatures })) },
  } as any;
}

const ctx = { tenantId: 't-1', conversationId: 'c-1' } as any;
const fakeMetrics = { counter: () => ({ inc: () => undefined }) } as any;

function registry(features: any) {
  const creds = credentials();
  return new ChannelRegistry(
    makePrisma(features),
    fakeMetrics,
    new WebChannelProvider(),
    new FacebookMessengerProvider(creds, graph),
    new InstagramChannelProvider(creds, graph),
    new TelegramChannelProvider(creds, bot),
  );
}

describe('ChannelRegistry (H-4)', () => {
  it('returns null when the channel is not in enabledChannels', async () => {
    expect(await registry({ multichannel: { enabledChannels: ['web'] } }).getProvider('t-1', 'facebook')).toBeNull();
  });

  it('returns the messenger provider for facebook when enabled', async () => {
    const provider = await registry({ multichannel: { enabledChannels: ['facebook'] } }).getProvider('t-1', 'facebook');
    expect(provider).toBeInstanceOf(FacebookMessengerProvider);
  });

  it('send() returns null when the channel is disabled', async () => {
    const calls = mockFetch([{ json: {} }]);
    const result = await registry({ multichannel: { enabledChannels: ['web'] } }).send('t-1', 'telegram', {
      externalUserId: '1',
      text: 'hi',
      ctx,
    });
    expect(result).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('falls back to WebChannelProvider for the web channel', async () => {
    expect(await registry({}).getProvider('t-1', 'web')).toBeInstanceOf(WebChannelProvider);
  });
});

describe('FacebookMessengerProvider', () => {
  it('posts to /{PAGE_ID}/messages with the Page token, as a RESPONSE, in plain text', async () => {
    const calls = mockFetch([{ json: { recipient_id: 'psid_1', message_id: 'm_ok_123' } }]);
    const provider = new FacebookMessengerProvider(credentials(), graph);
    const result = await provider.send({ externalUserId: 'psid_1', text: '**Martes** a las 10:00', ctx });
    expect(calls[0].url).toContain('https://graph.facebook.com/v21.0/1001/messages');
    expect(calls[0].url).toContain('access_token=PAGE_TOKEN');
    expect(calls[0].method).toBe('POST');
    expect(calls[0].body).toEqual({
      recipient: { id: 'psid_1' },
      messaging_type: 'RESPONSE',
      message: { text: 'Martes a las 10:00' },
    });
    expect(result.messageId).toBe('m_ok_123');
  });

  it('throws with Meta\'s message when the Graph API refuses', async () => {
    mockFetch([{ ok: false, status: 400, json: { error: { message: 'Invalid OAuth access token.', code: 190 } } }]);
    const provider = new FacebookMessengerProvider(credentials(), graph);
    await expect(provider.send({ externalUserId: 'psid', text: 'hola', ctx })).rejects.toThrow(
      /Invalid OAuth access token\./,
    );
  });

  it('falls back to the HTTP status when the error body is empty', async () => {
    mockFetch([{ ok: false, status: 500, json: {} }]);
    const provider = new FacebookMessengerProvider(credentials(), graph);
    await expect(provider.send({ externalUserId: 'psid', text: 'hola', ctx })).rejects.toThrow(/HTTP 500/);
  });

  it('refuses to send, without calling Meta, when the Page is not connected', async () => {
    const calls = mockFetch([{ json: {} }]);
    const provider = new FacebookMessengerProvider(credentials({ meta: null }), graph);
    await expect(provider.send({ externalUserId: 'psid', text: 'hi', ctx })).rejects.toThrow(/not connected/);
    expect(calls).toHaveLength(0);
  });

  it('parses a text message and skips echoes and non-text events', async () => {
    const provider = new FacebookMessengerProvider(credentials(), graph);
    const event = (message: any) => ({ body: { entry: [{ messaging: [{ sender: { id: 'psid-1' }, message }] }] } });
    expect(await provider.parseInbound(event({ mid: 'm_1', text: 'hola' }))).toMatchObject({
      channel: 'facebook',
      externalUserId: 'psid-1',
      text: 'hola',
      isFromUser: true,
    });
    expect(await provider.parseInbound(event({ mid: 'm_2' }))).toBeNull();
    expect(await provider.parseInbound(event({ mid: 'm_3', text: 'eco', is_echo: true }))).toBeNull();
    expect(await provider.parseInbound({})).toBeNull();
  });
});

describe('InstagramChannelProvider', () => {
  it('posts to /me/messages with the Page token and the Instagram-scoped id', async () => {
    const calls = mockFetch([{ json: { recipient_id: 'igsid', message_id: 'ig_msg_1' } }]);
    const provider = new InstagramChannelProvider(credentials(), graph);
    const result = await provider.send({ externalUserId: 'igsid_1', text: 'hola desde ig', ctx });
    expect(calls[0].url).toContain('https://graph.facebook.com/v21.0/me/messages');
    expect(calls[0].url).toContain('access_token=PAGE_TOKEN');
    expect(calls[0].body).toEqual({ recipient: { id: 'igsid_1' }, message: { text: 'hola desde ig' } });
    expect(result.messageId).toBe('ig_msg_1');
  });

  it('splits an answer longer than Instagram\'s 1000-character limit', async () => {
    const calls = mockFetch([{ json: { message_id: 'a' } }]);
    const provider = new InstagramChannelProvider(credentials(), graph);
    const paragraph = 'Servicio de peluquería con lavado incluido. '.repeat(15).trim();
    await provider.send({ externalUserId: 'igsid_1', text: `${paragraph}\n\n${paragraph}\n\n${paragraph}`, ctx });
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) expect(c.body.message.text.length).toBeLessThan(1000);
  });

  it('refuses to send when the Page has no linked Instagram account', async () => {
    const provider = new InstagramChannelProvider(credentials({ meta: { pageId: '1', pageToken: 't' } }), graph);
    await expect(provider.send({ externalUserId: 'x', text: 'hi', ctx })).rejects.toThrow(/Instagram is not connected/);
  });
});

describe('TelegramChannelProvider', () => {
  it('sends with the salon\'s bot token to sendMessage', async () => {
    const calls = mockFetch([{ json: { ok: true, result: { message_id: 9001 } } }]);
    const provider = new TelegramChannelProvider(credentials(), bot);
    const result = await provider.send({ externalUserId: '123456', text: '## Horario\nLunes', ctx });
    expect(calls[0].url).toBe('https://api.telegram.org/bot123456:BOT/sendMessage');
    expect(calls[0].body).toEqual({ chat_id: 123456, text: 'Horario\nLunes' });
    expect(result.messageId).toBe('9001');
  });

  it('throws with Telegram\'s description when the Bot API refuses', async () => {
    mockFetch([{ ok: false, status: 403, json: { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' } }]);
    const provider = new TelegramChannelProvider(credentials(), bot);
    await expect(provider.send({ externalUserId: '1', text: 'hola', ctx })).rejects.toThrow(/bot was blocked/);
  });

  it('rejects when the salon has no bot connected', async () => {
    const provider = new TelegramChannelProvider(credentials({ telegram: null }), bot);
    await expect(provider.send({ externalUserId: '123', text: 'hi', ctx })).rejects.toThrow(
      /bot token is not configured/,
    );
  });

  it('verifyWebhook compares the header with the expected secret in constant time', () => {
    const provider = new TelegramChannelProvider(credentials(), bot);
    const req = (h?: string) => ({ headers: h ? { 'x-telegram-bot-api-secret-token': h } : {}, expectedSecret: 'SECRET' });
    expect(provider.verifyWebhook(req('SECRET'))).toBe(true);
    expect(provider.verifyWebhook(req('WRONG!'))).toBe(false);
    expect(provider.verifyWebhook(req('short'))).toBe(false);
    expect(provider.verifyWebhook(req())).toBe(false);
  });

  it('parses a Telegram update, in both shapes', async () => {
    const provider = new TelegramChannelProvider(credentials(), bot);
    const message = { message_id: 10, chat: { id: 12345, type: 'private' }, from: { id: 9 }, text: 'hola tg' };
    expect(await provider.parseInbound({ body: { update_id: 1, message } })).toMatchObject({
      channel: 'telegram',
      externalUserId: '12345',
      text: 'hola tg',
    });
    expect(await provider.parseInbound({ body: { update: { message } } })).toMatchObject({ externalUserId: '12345' });
    expect(await provider.parseInbound({ body: { message: { ...message, text: undefined } } })).toBeNull();
  });
});

describe('WebChannelProvider', () => {
  it('never touches the network', async () => {
    const calls = mockFetch([{ json: {} }]);
    const result = await new WebChannelProvider().send({ externalUserId: 'u', text: 'hi', ctx });
    expect(result.messageId).toMatch(/^web-/);
    expect(calls).toHaveLength(0);
  });
});
