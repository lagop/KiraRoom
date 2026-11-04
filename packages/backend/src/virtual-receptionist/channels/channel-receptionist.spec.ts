import { ChannelReceptionistService } from './channel-receptionist.service';
import { splitForChannel, toPlainChatText } from './chat-text';
import { RedisService } from '../../common/cache/redis.service';
import { FacebookMessengerProvider } from './facebook-messenger.provider';
import { InstagramChannelProvider } from './instagram-channel.provider';
import { TelegramChannelProvider } from './telegram-channel.provider';

/**
 * The receptionist on Messenger, Instagram and Telegram.
 *
 * These messages used to be logged and never answered. Now each one goes to
 * the same receptionist as the web chat (whose reply the ChannelRegistry
 * delivers), handled once per message id, in order per sender, with a cap
 * per sender and hour; and when the receptionist fails or answers without
 * delivering, the person still gets a reply.
 */

function setup(
  over: { response?: any; vr?: boolean; channelOn?: boolean; lost?: { facebook: boolean; telegram: boolean }; redis?: RedisService } = {},
) {
  const prisma = { tenant: { findUnique: jest.fn(async () => ({ phone: '910000000' })) } } as any;
  const flags = { isEnabled: jest.fn(async () => over.vr ?? true) } as any;
  const receptionist = {
    sendMessage: jest.fn(async () =>
      over.response ?? { id: 'conv-1', content: 'Tenemos hueco el martes', channelDispatched: true },
    ),
  } as any;
  const registry = {
    send: jest.fn(async () => ({ messageId: 'out' })),
    isChannelEnabled: jest.fn(async () => over.channelOn ?? true),
  } as any;
  const credentials = {
    telegram: jest.fn(async () => ({ botToken: 'tok' })),
    accessLost: jest.fn(async () => over.lost ?? { facebook: false, telegram: false }),
  } as any;
  const telegram = { sendTyping: jest.fn(async () => ({ ok: true })) } as any;
  const redis = over.redis ?? new RedisService({ get: () => undefined } as any);
  const svc = new ChannelReceptionistService(prisma, flags, receptionist, registry, credentials, telegram, redis);
  return { svc, receptionist, registry, telegram };
}

const msg = (over: any = {}) => ({ channel: 'facebook' as const, id: 'm1', from: 'psid-1', text: 'hola', ...over });

describe('ChannelReceptionistService', () => {
  it('passes the message to the receptionist with the channel and the sender as conversation key', async () => {
    const { svc, receptionist, registry } = setup();
    await svc.enqueue('t1', msg());
    expect(receptionist.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'facebook-psid-1',
        salonId: 't1',
        tenantId: 't1',
        message: 'hola',
        channel: 'facebook',
        metadata: { externalUserId: 'psid-1' },
      }),
    );
    // Delivered by sendMessage through the registry: not sent twice.
    expect(registry.send).not.toHaveBeenCalled();
  });

  it('handles a retried delivery (same message id) once', async () => {
    const { svc, receptionist } = setup();
    await svc.enqueue('t1', msg());
    await svc.enqueue('t1', msg());
    expect(receptionist.sendMessage).toHaveBeenCalledTimes(1);
  });

  it('answers in order for the same sender', async () => {
    const { svc, receptionist } = setup();
    const order: string[] = [];
    receptionist.sendMessage.mockImplementation(async (dto: any) => {
      await new Promise((r) => setTimeout(r, dto.message === 'uno' ? 20 : 0));
      order.push(dto.message);
      return { id: 'c', content: 'ok', channelDispatched: true };
    });
    await Promise.all([svc.enqueue('t1', msg({ id: 'a', text: 'uno' })), svc.enqueue('t1', msg({ id: 'b', text: 'dos' }))]);
    expect(order).toEqual(['uno', 'dos']);
  });

  it('sends an apology with the salon phone when the receptionist fails', async () => {
    const { svc, registry } = setup({ response: { id: 'error-response', content: 'x' } });
    await svc.enqueue('t1', msg());
    expect(registry.send).toHaveBeenCalledWith('t1', 'facebook', expect.objectContaining({
      externalUserId: 'psid-1',
      text: expect.stringContaining('910000000'),
    }));
  });

  it('delivers the answer itself when sendMessage did not (e.g. AI allowance used up)', async () => {
    const { svc, registry } = setup({ response: { id: 'c', content: 'Hemos alcanzado el límite', channelDispatched: false } });
    await svc.enqueue('t1', msg({ channel: 'instagram' }));
    expect(registry.send).toHaveBeenCalledWith('t1', 'instagram', expect.objectContaining({ text: 'Hemos alcanzado el límite' }));
  });

  it('answers a photo or a voice note with a short text: the salon will see it on Messenger (M10)', async () => {
    const { svc, receptionist, registry } = setup();
    await svc.enqueue('t1', msg({ text: undefined, hasAttachment: true }));
    expect(receptionist.sendMessage).not.toHaveBeenCalled();
    expect(registry.send.mock.calls[0][2].text).toBe(
      'No puedo escuchar audios ni ver fotos o archivos, pero el salón lo verá. Si quieres, escríbeme lo que necesitas y te ayudo, o llama al salón al 910000000.',
    );
  });

  it('on Telegram, where nobody else sees the chat, it does not promise the salon will see it', async () => {
    const { svc, registry } = setup();
    await svc.enqueue('t1', msg({ channel: 'telegram', from: '55', text: undefined, hasAttachment: true }));
    expect(registry.send.mock.calls[0][2].text).not.toMatch(/el salón lo verá/);
  });

  it('a channel switched off in the panel is not answered and spends no AI (M9)', async () => {
    const { svc, receptionist, registry } = setup({ channelOn: false });
    await svc.enqueue('t1', msg({ channel: 'instagram' }));
    expect(receptionist.sendMessage).not.toHaveBeenCalled();
    expect(registry.send).not.toHaveBeenCalled();
  });

  it('a Page whose token Facebook refused is not answered either (M5)', async () => {
    const { svc, receptionist } = setup({ lost: { facebook: true, telegram: false } });
    await svc.enqueue('t1', msg({ channel: 'instagram' }));
    expect(receptionist.sendMessage).not.toHaveBeenCalled();
  });

  it('remembers a delivery across a restart: Redis, not the process (M12)', async () => {
    const shared = new RedisService({ get: () => undefined } as any);
    const a = setup({ redis: shared });
    const b = setup({ redis: shared });
    await a.svc.enqueue('t1', msg());
    await b.svc.enqueue('t1', msg());
    expect(a.receptionist.sendMessage).toHaveBeenCalledTimes(1);
    expect(b.receptionist.sendMessage).not.toHaveBeenCalled();
  });

  it('turns Telegram\'s /start into a greeting and shows "typing"', async () => {
    const { svc, receptionist, telegram } = setup();
    await svc.enqueue('t1', msg({ channel: 'telegram', from: '55', text: '/start', name: 'Ana' }));
    expect(telegram.sendTyping).toHaveBeenCalledWith('tok', '55');
    expect(receptionist.sendMessage.mock.calls[0][0]).toMatchObject({
      message: 'Hola',
      metadata: { externalUserId: '55', clientName: 'Ana' },
    });
  });

  it('does nothing when the salon has the receptionist off', async () => {
    const { svc, receptionist, registry } = setup({ vr: false });
    await svc.enqueue('t1', msg());
    expect(receptionist.sendMessage).not.toHaveBeenCalled();
    expect(registry.send).not.toHaveBeenCalled();
  });

  it('caps each sender at 30 messages an hour', async () => {
    const { svc, receptionist } = setup();
    for (let i = 0; i < 32; i++) await svc.enqueue('t1', msg({ id: `m${i}` }));
    expect(receptionist.sendMessage).toHaveBeenCalledTimes(30);
  });
});

describe('a long answer in several messages, when one fails half-way (M17)', () => {
  const ctx = { tenantId: 't1', conversationId: 'c1' };
  const long = 'a'.repeat(1500) + '\n' + 'b'.repeat(1500);

  function messenger(results: any[]) {
    const graph = { sendMessengerText: jest.fn(async () => results.shift()) } as any;
    const credentials = { meta: jest.fn(async () => ({ pageId: 'p1', pageToken: 'pt' })) } as any;
    const health = { pageTokenError: jest.fn(async () => true) } as any;
    return { provider: new FacebookMessengerProvider(credentials, graph, health), graph, health };
  }

  it('Messenger: after a part arrived, a failure is not thrown (the caller would resend everything)', async () => {
    const { provider, graph } = messenger([
      { ok: true, data: { message_id: 'mid.1' } },
      { ok: false, error: { message: 'temporary', code: 2 } },
    ]);
    const out = await provider.send({ externalUserId: 'psid', text: long, ctx });
    expect(graph.sendMessengerText).toHaveBeenCalledTimes(2);
    expect(out).toEqual({ messageId: 'mid.1', raw: { partial: true, sent: 1, total: 2 } });
  });

  it('Messenger: when the first part fails nothing arrived, so it throws and the caller may retry', async () => {
    const { provider } = messenger([{ ok: false, error: { message: 'temporary', code: 2 } }]);
    await expect(provider.send({ externalUserId: 'psid', text: long, ctx })).rejects.toThrow(/send failed/);
  });

  it('Messenger: a refused Page token marks the connection (M5)', async () => {
    const { provider, health } = messenger([{ ok: false, error: { message: 'expired', code: 190 } }]);
    await provider.send({ externalUserId: 'psid', text: 'hola', ctx }).catch(() => undefined);
    expect(health.pageTokenError).toHaveBeenCalledWith('t1', 190);
  });

  it('Instagram and Telegram behave the same', async () => {
    const igGraph = {
      sendInstagramText: jest
        .fn()
        .mockResolvedValueOnce({ ok: true, data: { message_id: 'ig.1' } })
        .mockResolvedValueOnce({ ok: false, error: { message: 'x' } }),
    } as any;
    const ig = new InstagramChannelProvider(
      { meta: jest.fn(async () => ({ pageId: 'p1', pageToken: 'pt', instagramId: 'i1' })) } as any,
      igGraph,
    );
    expect((await ig.send({ externalUserId: 'igsid', text: 'a'.repeat(900) + '\n' + 'b'.repeat(900), ctx })).raw).toEqual({
      partial: true,
      sent: 1,
      total: 2,
    });

    const bot = {
      sendMessage: jest
        .fn()
        .mockResolvedValueOnce({ ok: true, result: { message_id: 7 } })
        .mockResolvedValueOnce({ ok: false, description: 'Unauthorized', error_code: 401 }),
    } as any;
    const health = { botTokenError: jest.fn(async () => true) } as any;
    const tg = new TelegramChannelProvider({ telegram: jest.fn(async () => ({ botToken: 'tok' })) } as any, bot, health);
    const out = await tg.send({ externalUserId: '55', text: 'a'.repeat(4000) + '\n' + 'b'.repeat(4000), ctx });
    expect(out).toEqual({ messageId: '7', raw: { partial: true, sent: 1, total: 2 } });
    expect(health.botTokenError).toHaveBeenCalledWith('t1', 401);
  });
});

describe('chat text', () => {
  it('drops Markdown these apps would show literally', () => {
    expect(toPlainChatText('## Horario\n**Lunes**: 10-20\n- Corte\n[Reserva](https://x.es/r)')).toBe(
      'Horario\nLunes: 10-20\n• Corte\nReserva: https://x.es/r',
    );
  });

  it('splits at line breaks under the limit', () => {
    const parts = splitForChannel('aaaa\nbbbb\ncccc', 10);
    expect(parts).toEqual(['aaaa\nbbbb', 'cccc']);
    expect(splitForChannel('corto', 10)).toEqual(['corto']);
  });
});
