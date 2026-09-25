import { WebChannelProvider } from './web-channel.provider';
import { FacebookMessengerProvider } from './facebook-messenger.provider';
import { InstagramChannelProvider } from './instagram-channel.provider';
import { TelegramChannelProvider } from './telegram-channel.provider';

/**
 * L-4 extended coverage: error paths and edge cases for every
 * channel provider. The happy-path send tests live in
 * channel-registry.l4.spec.ts; this file targets the failure modes
 * documented in P2A-receptionist-v2 H-4 (token missing, non-200 from
 * Meta/Telegram, malformed webhook payloads, mismatched webhook
 * secret length, etc).
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

function makePrismaMissingTenant() {
  return {
    tenant: {
      findUnique: jest.fn().mockImplementation(async () => null),
    },
  } as any;
}

describe('FacebookMessengerProvider error paths (H-4)', () => {
  afterEach(() => restoreFetch());

  it('throws when the Graph API responds with a 400 + error.message', async () => {
    mockFetchOnce(async () => ({
      ok: false,
      status: 400,
      statusText: 'Bad Request',
      json: async () => ({ error: { message: 'Invalid OAuth access token.' } }),
    }));

    const provider = new FacebookMessengerProvider(
      makePrisma({ multichannel: { meta: { pageAccessToken: 'EAA_test_token' } } }),
    );

    await expect(
      provider.send({
        externalUserId: 'psid_x',
        text: 'hola',
        ctx: { tenantId: 't-1', conversationId: 'c-1' } as any,
      }),
    ).rejects.toThrow(/Invalid OAuth access token\./);
  });

  it('falls back to statusText when the error body has no error.message', async () => {
    mockFetchOnce(async () => ({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      json: async () => ({}),
    }));

    const provider = new FacebookMessengerProvider(
      makePrisma({ multichannel: { meta: { pageAccessToken: 'tok' } } }),
    );

    await expect(
      provider.send({
        externalUserId: 'psid_x',
        text: 'hola',
        ctx: { tenantId: 't-1', conversationId: 'c-1' } as any,
      }),
    ).rejects.toThrow(/Internal Server Error/);
  });

  it('throws when the tenant does not exist', async () => {
    mockFetchOnce(async () => {
      throw new Error('fetch should not be called when tenant is missing');
    });
    const provider = new FacebookMessengerProvider(makePrismaMissingTenant());

    await expect(
      provider.send({
        externalUserId: 'psid_x',
        text: 'hola',
        ctx: { tenantId: 't-1', conversationId: 'c-1' } as any,
      }),
    ).rejects.toThrow(/token missing/);
  });
});

describe('FacebookMessengerProvider.parseInbound edge cases (H-4)', () => {
  const provider = new FacebookMessengerProvider(makePrisma());

  it('returns null when body is undefined', async () => {
    expect(await provider.parseInbound({})).toBeNull();
  });

  it('returns null when entry[] is empty', async () => {
    expect(
      await provider.parseInbound({ body: { entry: [] } }),
    ).toBeNull();
  });

  it('returns null when messaging[] is empty', async () => {
    expect(
      await provider.parseInbound({ body: { entry: [{ messaging: [] }] } }),
    ).toBeNull();
  });

  it('returns null when message.text is missing (attachment only)', async () => {
    expect(
      await provider.parseInbound({
        body: {
          entry: [
            {
              messaging: [
                {
                  sender: { id: 'psid-1' },
                  message: { mid: 'm_attach', attachments: [] },
                },
              ],
            },
          ],
        },
      }),
    ).toBeNull();
  });

  it('exposes the original sender.id on both externalUserId and providerConversationId', async () => {
    const parsed = await provider.parseInbound({
      body: {
        entry: [
          {
            messaging: [
              {
                sender: { id: 'psid-77' },
                message: { mid: 'm_77', text: 'reservation?' },
              },
            ],
          },
        ],
      },
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.externalUserId).toBe('psid-77');
    expect(parsed!.providerConversationId).toBe('psid-77');
    expect(parsed!.metadata).toMatchObject({ messageId: 'm_77' });
  });
});

describe('InstagramChannelProvider (H-4)', () => {
  afterEach(() => restoreFetch());

  it('parseInbound returns a normalized IG message', async () => {
    const provider = new InstagramChannelProvider(makePrisma());
    const parsed = await provider.parseInbound({
      body: {
        entry: [
          {
            messaging: [
              {
                sender: { id: 'igid-1' },
                message: { mid: 'ig_mid_1', text: 'hola ig' },
              },
            ],
          },
        ],
      },
    });
    expect(parsed).toMatchObject({
      channel: 'instagram',
      externalUserId: 'igid-1',
      text: 'hola ig',
      isFromUser: true,
    });
    expect(parsed!.metadata).toMatchObject({ messageId: 'ig_mid_1' });
  });

  it('parseInbound returns null when the IG message has no text', async () => {
    const provider = new InstagramChannelProvider(makePrisma());
    expect(
      await provider.parseInbound({
        body: {
          entry: [{ messaging: [{ sender: { id: 'igid-2' }, message: { mid: 'ig_2' } }] }],
        },
      }),
    ).toBeNull();
  });

  it('throws on non-OK Graph response with the error.message from the body', async () => {
    mockFetchOnce(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: { message: 'Invalid IGSID' } }),
    }));

    const provider = new InstagramChannelProvider(
      makePrisma({ multichannel: { meta: { pageAccessToken: 'EAA_ig' } } }),
    );

    await expect(
      provider.send({
        externalUserId: 'igid_x',
        text: 'hola',
        ctx: { tenantId: 't-1', conversationId: 'c-1' } as any,
      }),
    ).rejects.toThrow(/Invalid IGSID/);
  });

  it('throws when the access token is missing', async () => {
    const provider = new InstagramChannelProvider(makePrisma({}));
    await expect(
      provider.send({
        externalUserId: 'igid',
        text: 'hi',
        ctx: { tenantId: 't-1', conversationId: 'c-1' } as any,
      }),
    ).rejects.toThrow(/token missing/);
  });
});

describe('TelegramChannelProvider error paths (H-4)', () => {
  afterEach(() => restoreFetch());

  it('throws when the Bot API responds with a non-200 and exposes the description', async () => {
    mockFetchOnce(async () => ({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
      json: async () => ({ ok: false, description: 'Forbidden: bot was blocked by the user' }),
    }));

    const provider = new TelegramChannelProvider();
    await expect(
      provider.send({
        externalUserId: '42',
        text: 'hola',
        ctx: {
          tenantId: 't-1',
          conversationId: 'c-1',
          metadata: { telegramBotToken: 'BOT_TOKEN' },
        } as any,
      }),
    ).rejects.toThrow(/bot was blocked by the user/);
  });

  it('falls back to statusText when the error body has no description', async () => {
    mockFetchOnce(async () => ({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
      json: async () => ({ ok: false }),
    }));

    const provider = new TelegramChannelProvider();
    await expect(
      provider.send({
        externalUserId: '42',
        text: 'hola',
        ctx: {
          tenantId: 't-1',
          conversationId: 'c-1',
          metadata: { telegramBotToken: 'BOT_TOKEN' },
        } as any,
      }),
    ).rejects.toThrow(/Bad Gateway/);
  });

  it('coerces a string chat_id to Number in the send payload', async () => {
    let captured: any = {};
    mockFetchOnce(async (url, init) => {
      captured = { url: String(url), body: init?.body };
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        json: async () => ({ ok: true, result: { message_id: 7 } }),
      };
    });

    const provider = new TelegramChannelProvider();
    await provider.send({
      externalUserId: '9999',
      text: 'hola string chat',
      ctx: {
        tenantId: 't-1',
        conversationId: 'c-1',
        metadata: { telegramBotToken: 'BOT_TOKEN' },
      } as any,
    });

    const body = JSON.parse(String(captured.body));
    expect(body.chat_id).toBe(9999);
    expect(typeof body.chat_id).toBe('number');
  });
});

describe('TelegramChannelProvider.parseInbound (H-4 webhook payload)', () => {
  const provider = new TelegramChannelProvider();

  it('accepts the wrapped { update: { message } } shape', async () => {
    const parsed = await provider.parseInbound({
      body: {
        update: {
          update_id: 100,
          message: {
            message_id: 20,
            chat: { id: 555, type: 'private' },
            from: { id: 555, is_bot: false },
            text: 'wrapped',
          },
        },
      },
    });
    expect(parsed).toMatchObject({
      channel: 'telegram',
      externalUserId: '555',
      text: 'wrapped',
    });
  });

  it('returns null when no message field is present', async () => {
    expect(
      await provider.parseInbound({ body: { update_id: 1 } }),
    ).toBeNull();
  });

  it('returns null for a message without text (e.g. sticker, voice)', async () => {
    expect(
      await provider.parseInbound({
        body: { update_id: 1, message: { message_id: 1, chat: { id: 1 } } },
      }),
    ).toBeNull();
  });

  it('returns null when body is empty', async () => {
    expect(await provider.parseInbound({})).toBeNull();
  });
});

describe('TelegramChannelProvider.verifyWebhook edge cases (H-4)', () => {
  const provider = new TelegramChannelProvider();

  it('returns false when the X-Telegram-Bot-Api-Secret-Token header is missing', () => {
    const ok = provider.verifyWebhook({
      headers: {},
      ctx: { metadata: { telegramBotToken: 'BOT_TOKEN' } },
    });
    expect(ok).toBe(false);
  });

  it('returns false when the configured bot token is missing from ctx', () => {
    const ok = provider.verifyWebhook({
      headers: { 'x-telegram-bot-api-secret-token': 'BOT_TOKEN' },
      ctx: { metadata: {} },
    });
    expect(ok).toBe(false);
  });

  it('returns false (does not throw) when header and configured token differ in length', () => {
    const ok = provider.verifyWebhook({
      headers: { 'x-telegram-bot-api-secret-token': 'SHORT' },
      ctx: { metadata: { telegramBotToken: 'A_MUCH_LONGER_CONFIGURED_SECRET' } },
    });
    expect(ok).toBe(false);
  });
});

describe('WebChannelProvider (H-4)', () => {
  it('verifyWebhook always returns true (no signature on internal webhooks)', () => {
    const provider = new WebChannelProvider();
    expect(provider.verifyWebhook({})).toBe(true);
  });

  it('parseInbound always returns null (web channel uses its own ingestion path)', async () => {
    const provider = new WebChannelProvider();
    expect(await provider.parseInbound({ body: { anything: 'goes' } })).toBeNull();
  });

  it('send returns a stub messageId without touching the network', async () => {
    const fetchSpy = jest.fn();
    (globalThis as any).fetch = fetchSpy;
    try {
      const provider = new WebChannelProvider();
      const result = await provider.send({
        externalUserId: 'web-user',
        text: 'hola web',
        ctx: { tenantId: 't-1', conversationId: 'c-1' } as any,
      });
      expect(result.messageId).toMatch(/^web-\d+$/);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      (globalThis as any).fetch = originalFetch;
    }
  });
});
