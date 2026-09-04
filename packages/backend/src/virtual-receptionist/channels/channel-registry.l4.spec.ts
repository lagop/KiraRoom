import { ChannelRegistry } from './channel.registry';
import { WebChannelProvider } from './web-channel.provider';
import { FacebookMessengerProvider } from './facebook-messenger.provider';
import { InstagramChannelProvider } from './instagram-channel.provider';
import { TelegramChannelProvider } from './telegram-channel.provider';

/**
 * L-4 specs: pin the contract of ChannelRegistry + the four
 * providers. The actual Meta and Telegram HTTP calls are mocked
 * globally with globalThis.fetch so the tests don't hit the network.
 */

const originalFetch = (globalThis as any).fetch;
function mockFetchOnce(impl: (input: any, init?: any) => Promise<any>) {
  (globalThis as any).fetch = jest.fn(impl);
}
function restoreFetch() {
  (globalThis as any).fetch = originalFetch;
}

function makePrisma(tenantFeatures: any = {}) {
  return {
    tenant: {
      findUnique: jest.fn().mockImplementation(async () => ({
        id: 't-1',
        features: tenantFeatures,
      })),
    },
  } as any;
}

describe('ChannelRegistry (H-4)', () => {
  afterEach(() => restoreFetch());

  const fakeMetrics = {
  counter: () => ({ inc: () => undefined }),
} as any;

it('returns null when the channel is not in enabledChannels', async () => {
  const registry = new ChannelRegistry(
    makePrisma({ multichannel: { enabledChannels: ['web'] } }),
    fakeMetrics,
    new WebChannelProvider(),
    new FacebookMessengerProvider(makePrisma()),
    new InstagramChannelProvider(makePrisma()),
    new TelegramChannelProvider(),
  );
  const provider = await registry.getProvider('t-1', 'facebook');
  expect(provider).toBeNull();
});

it('returns the messenger provider for facebook when enabled', async () => {
  const registry = new ChannelRegistry(
    makePrisma({
      multichannel: { enabledChannels: ['facebook'] },
    }),
    fakeMetrics,
    new WebChannelProvider(),
    new FacebookMessengerProvider(makePrisma()),
    new InstagramChannelProvider(makePrisma()),
    new TelegramChannelProvider(),
  );
  const provider = await registry.getProvider('t-1', 'facebook');
  expect(provider).toBeInstanceOf(FacebookMessengerProvider);
});

it('send() returns null when the channel is disabled', async () => {
  const registry = new ChannelRegistry(
    makePrisma({ multichannel: { enabledChannels: ['web'] } }),
    fakeMetrics,
    new WebChannelProvider(),
    new FacebookMessengerProvider(makePrisma()),
    new InstagramChannelProvider(makePrisma()),
    new TelegramChannelProvider(),
  );
  const result = await registry.send('t-1', 'facebook', {
    externalUserId: 'psid-1',
    text: 'hi',
    ctx: { tenantId: 't-1', conversationId: 'c-1' } as any,
  });
  expect(result).toBeNull();
});

it('falls back to WebChannelProvider for the web channel', async () => {
  const registry = new ChannelRegistry(
    makePrisma(),
    fakeMetrics,
    new WebChannelProvider(),
    new FacebookMessengerProvider(makePrisma()),
    new InstagramChannelProvider(makePrisma()),
    new TelegramChannelProvider(),
  );
  const provider = await registry.getProvider('t-1', 'web');
  expect(provider).toBeInstanceOf(WebChannelProvider);
});
});

describe('FacebookMessengerProvider (H-4 outbound)', () => {
  afterEach(() => restoreFetch());

  it('calls graph.facebook.com/v21.0/me/messages with the right recipient + text', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    mockFetchOnce(async (url, init) => {
      captured = { url: String(url), init };
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ message_id: 'm_ok_123' }),
      };
    });

    const provider = new FacebookMessengerProvider(
      makePrisma({
        multichannel: {
          enabledChannels: ['facebook'],
          meta: { pageAccessToken: 'EAA_test_token' },
        },
      }),
    );

    const result = await provider.send({
      externalUserId: 'psid_user_1',
      text: 'hola desde facebook',
      ctx: { tenantId: 't-1', conversationId: 'c-1' } as any,
    });

    expect(captured.url).toContain('graph.facebook.com/v21.0/me/messages');
    expect(captured.url).toContain('access_token=EAA_test_token');
    const body = JSON.parse(String(captured.init?.body));
    expect(body.recipient.id).toBe('psid_user_1');
    expect(body.message.text).toBe('hola desde facebook');
    expect(body.messaging_type).toBe('RESPONSE');
    expect(result.messageId).toBe('m_ok_123');
  });

  it('throws when the access token is missing', async () => {
    const provider = new FacebookMessengerProvider(
      makePrisma({ multichannel: { enabledChannels: ['facebook'] } }),
    );
    await expect(
      provider.send({
        externalUserId: 'psid',
        text: 'hi',
        ctx: { tenantId: 't-1', conversationId: 'c-1' } as any,
      }),
    ).rejects.toThrow(/token missing/);
  });
});

describe('InstagramChannelProvider (H-4 outbound)', () => {
  afterEach(() => restoreFetch());

  it('uses the same graph endpoint as messenger', async () => {
    let captured: any = {};
    mockFetchOnce(async (url, init) => {
      captured = { url: String(url), body: init?.body };
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ message_id: 'ig_msg_1' }),
      };
    });
    const provider = new InstagramChannelProvider(
      makePrisma({
        multichannel: {
          enabledChannels: ['instagram'],
          meta: { pageAccessToken: 'EAA_ig_token' },
        },
      }),
    );
    const result = await provider.send({
      externalUserId: 'igid_user_1',
      text: 'hola desde ig',
      ctx: { tenantId: 't-1', conversationId: 'c-1' } as any,
    });
    expect(captured.url).toContain('graph.facebook.com/v21.0/me/messages');
    const body = JSON.parse(String(captured.body));
    expect(body.recipient.id).toBe('igid_user_1');
    expect(body.message.text).toBe('hola desde ig');
    expect(result.messageId).toBe('ig_msg_1');
  });
});

describe('TelegramChannelProvider (H-4 outbound + verifyWebhook)', () => {
  afterEach(() => restoreFetch());

  it('hits api.telegram.org/bot<token>/sendMessage', async () => {
    let captured: { url?: string; body?: any } = {};
    mockFetchOnce(async (url, init) => {
      captured = { url: String(url), body: init?.body };
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ result: { message_id: 9001 } }),
      };
    });
    const provider = new TelegramChannelProvider();
    const result = await provider.send({
      externalUserId: '123456',
      text: 'hola telegram',
      ctx: {
        tenantId: 't-1',
        conversationId: 'c-1',
        metadata: { telegramBotToken: 'BOT_TOKEN' },
      } as any,
    });
    expect(captured.url).toBe('https://api.telegram.org/botBOT_TOKEN/sendMessage');
    const body = JSON.parse(String(captured.body));
    expect(body.chat_id).toBe(123456);
    expect(body.text).toBe('hola telegram');
    expect(result.messageId).toBe('9001');
  });

  it('rejects when the bot token is missing from the outbound ctx', async () => {
    const provider = new TelegramChannelProvider();
    await expect(
      provider.send({
        externalUserId: '123',
        text: 'hi',
        ctx: { tenantId: 't-1', conversationId: 'c-1' } as any,
      }),
    ).rejects.toThrow(/bot token is not configured/);
  });

  it('verifyWebhook does a constant-time compare against the configured token', () => {
    const provider = new TelegramChannelProvider();
    const ok = provider.verifyWebhook({
      headers: { 'x-telegram-bot-api-secret-token': 'BOT_TOKEN' },
      ctx: { metadata: { telegramBotToken: 'BOT_TOKEN' } },
    });
    expect(ok).toBe(true);
    const bad = provider.verifyWebhook({
      headers: { 'x-telegram-bot-api-secret-token': 'WRONG' },
      ctx: { metadata: { telegramBotToken: 'BOT_TOKEN' } },
    });
    expect(bad).toBe(false);
  });
});

describe('FacebookMessengerProvider.parseInbound (H-4 webhook payload)', () => {
  it('returns the text and the sender id from a Meta messaging event', async () => {
    const provider = new FacebookMessengerProvider(makePrisma());
    const parsed = await provider.parseInbound({
      body: {
        entry: [
          {
            messaging: [
              {
                sender: { id: 'psid-1' },
                message: { mid: 'm_1', text: 'hola' },
              },
            ],
          },
        ],
      },
    });
    expect(parsed).toMatchObject({
      channel: 'facebook',
      externalUserId: 'psid-1',
      text: 'hola',
      isFromUser: true,
    });
  });

  it('returns null for non-text events (delivery receipts, reactions, etc)', async () => {
    const provider = new FacebookMessengerProvider(makePrisma());
    const parsed = await provider.parseInbound({
      body: { entry: [{ messaging: [{ sender: { id: 'psid-2' }, message: { mid: 'm_2' } }] }] },
    });
    expect(parsed).toBeNull();
  });
});

describe('TelegramChannelProvider.parseInbound (H-4 webhook payload)', () => {
  it('returns the text and the chat_id from a Telegram update', async () => {
    const provider = new TelegramChannelProvider();
    const parsed = await provider.parseInbound({
      body: {
        update_id: 999,
        message: {
          message_id: 10,
          chat: { id: 12345, type: 'private' },
          from: { id: 999, is_bot: false },
          text: 'hola tg',
        },
      },
    });
    expect(parsed).toMatchObject({
      channel: 'telegram',
      externalUserId: '12345',
      text: 'hola tg',
      isFromUser: true,
    });
  });
});
