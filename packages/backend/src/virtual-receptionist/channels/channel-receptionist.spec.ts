import { ChannelReceptionistService } from './channel-receptionist.service';
import { splitForChannel, toPlainChatText } from './chat-text';

/**
 * The receptionist on Messenger, Instagram and Telegram.
 *
 * These messages used to be logged and never answered. Now each one goes to
 * the same receptionist as the web chat (whose reply the ChannelRegistry
 * delivers), handled once per message id, in order per sender, with a cap
 * per sender and hour; and when the receptionist fails or answers without
 * delivering, the person still gets a reply.
 */

function setup(over: { response?: any; vr?: boolean } = {}) {
  const prisma = { tenant: { findUnique: jest.fn(async () => ({ phone: '910000000' })) } } as any;
  const flags = { isEnabled: jest.fn(async () => over.vr ?? true) } as any;
  const receptionist = {
    sendMessage: jest.fn(async () =>
      over.response ?? { id: 'conv-1', content: 'Tenemos hueco el martes', channelDispatched: true },
    ),
  } as any;
  const registry = { send: jest.fn(async () => ({ messageId: 'out' })) } as any;
  const credentials = { telegram: jest.fn(async () => ({ botToken: 'tok' })) } as any;
  const telegram = { sendTyping: jest.fn(async () => ({ ok: true })) } as any;
  const svc = new ChannelReceptionistService(prisma, flags, receptionist, registry, credentials, telegram);
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

  it('tells the person it only reads text when they send a photo or a voice note', async () => {
    const { svc, receptionist, registry } = setup();
    await svc.enqueue('t1', msg({ text: undefined, hasAttachment: true }));
    expect(receptionist.sendMessage).not.toHaveBeenCalled();
    expect(registry.send.mock.calls[0][2].text).toMatch(/solo puedo leer mensajes de texto/);
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
