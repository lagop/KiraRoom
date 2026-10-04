import { createHmac } from 'crypto';
import { UnauthorizedException } from '@nestjs/common';
import { ChannelsWebhookController } from './channels-webhook.controller';

/**
 * The Messenger / Instagram / Telegram webhooks.
 *
 * Messages to these channels used to be logged and nothing else, and the
 * Telegram route found the salon through a list of chats nothing filled.
 * Now: the salon is found by Page id, Instagram account id or the URL of its
 * bot's webhook; signatures are verified (X-Hub-Signature-256 with the app
 * secret, X-Telegram-Bot-Api-Secret-Token with the salon's secret); a salon
 * without the `multichannel` feature is dropped (fail-closed); and the rest
 * go to the receptionist queue.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

function setup(over: {
  appSecret?: string;
  multichannel?: boolean | 'throw';
  telegram?: any;
} = {}) {
  const config = {
    get: (k: string) => (k === 'META_APP_SECRET' ? over.appSecret : undefined),
  } as any;
  const whatsapp = {
    verifyWebhook: (payload: string, sig?: string) =>
      !!sig &&
      sig === 'sha256=' + createHmac('sha256', over.appSecret ?? '').update(payload).digest('hex'),
  } as any;
  const credentials = {
    tenantForPage: jest.fn(async (id: string) => (id === 'page-1' ? TENANT : null)),
    tenantForInstagram: jest.fn(async (id: string) => (id === 'ig-1' ? TENANT : null)),
    telegram: jest.fn(async () =>
      over.telegram === undefined ? { botToken: 'tok', webhookSecret: 'sekret' } : over.telegram,
    ),
  } as any;
  const receptionist = { enqueue: jest.fn(async () => undefined) } as any;
  const flags = {
    isEnabled: jest.fn(async (_t: string, key: string) => {
      if (key !== 'multichannel') return true;
      if (over.multichannel === 'throw') throw new Error('db down');
      return over.multichannel ?? true;
    }),
  } as any;
  const metrics = { counter: () => ({ inc: () => undefined }) } as any;
  const ctrl = new ChannelsWebhookController(config, whatsapp, credentials, receptionist, flags, metrics);
  return { ctrl, receptionist, credentials };
}

const res = () => ({ json: jest.fn(), status: jest.fn().mockReturnThis(), send: jest.fn() }) as any;

function messengerBody(text = 'hola', extra: any = {}) {
  return {
    object: 'page',
    entry: [
      {
        id: 'page-1',
        messaging: [{ sender: { id: 'psid-1' }, recipient: { id: 'page-1' }, message: { mid: 'm1', text, ...extra } }],
      },
    ],
  };
}

describe('ChannelsWebhookController: Meta', () => {
  it('queues a Messenger message for the salon that owns the Page', async () => {
    const { ctrl, receptionist } = setup();
    const r = res();
    await ctrl.handleMeta(messengerBody(), { headers: {} } as any, r);
    expect(receptionist.enqueue).toHaveBeenCalledWith(TENANT, {
      channel: 'facebook',
      id: 'm1',
      from: 'psid-1',
      text: 'hola',
      hasAttachment: false,
    });
    expect(r.json).toHaveBeenCalledWith({ received: true });
  });

  it('finds the salon of an Instagram message by its Instagram account id', async () => {
    const { ctrl, receptionist } = setup();
    const body = {
      object: 'instagram',
      entry: [{ id: 'ig-1', messaging: [{ sender: { id: 'igsid-9' }, recipient: { id: 'ig-1' }, message: { mid: 'm2', text: 'precio?' } }] }],
    };
    await ctrl.handleMeta(body, { headers: {} } as any, res());
    expect(receptionist.enqueue).toHaveBeenCalledWith(TENANT, expect.objectContaining({ channel: 'instagram', from: 'igsid-9' }));
  });

  it('ignores echoes of the salon\'s own replies', async () => {
    const { ctrl, receptionist } = setup();
    await ctrl.handleMeta(messengerBody('respuesta', { is_echo: true }), { headers: {} } as any, res());
    expect(receptionist.enqueue).not.toHaveBeenCalled();
  });

  it('ignores Pages not connected to any salon', async () => {
    const { ctrl, receptionist } = setup();
    const body = messengerBody();
    body.entry[0].id = 'page-unknown';
    await ctrl.handleMeta(body, { headers: {} } as any, res());
    expect(receptionist.enqueue).not.toHaveBeenCalled();
  });

  it('drops the message when the salon lacks the multichannel feature', async () => {
    const { ctrl, receptionist } = setup({ multichannel: false });
    await ctrl.handleMeta(messengerBody(), { headers: {} } as any, res());
    expect(receptionist.enqueue).not.toHaveBeenCalled();
  });

  it('fails closed when the feature lookup throws', async () => {
    const { ctrl, receptionist } = setup({ multichannel: 'throw' });
    await ctrl.handleMeta(messengerBody(), { headers: {} } as any, res());
    expect(receptionist.enqueue).not.toHaveBeenCalled();
  });

  it('rejects a body whose X-Hub-Signature-256 does not match the raw body', async () => {
    const { ctrl, receptionist } = setup({ appSecret: 'app-secret' });
    const body = messengerBody();
    const raw = Buffer.from(JSON.stringify(body));
    await expect(
      ctrl.handleMeta(body, { headers: { 'x-hub-signature-256': 'sha256=deadbeef' }, rawBody: raw } as any, res()),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(receptionist.enqueue).not.toHaveBeenCalled();
  });

  it('accepts a correctly signed body', async () => {
    const { ctrl, receptionist } = setup({ appSecret: 'app-secret' });
    const body = messengerBody();
    const raw = Buffer.from(JSON.stringify(body));
    const sig = 'sha256=' + createHmac('sha256', 'app-secret').update(raw).digest('hex');
    await ctrl.handleMeta(body, { headers: { 'x-hub-signature-256': sig }, rawBody: raw } as any, res());
    expect(receptionist.enqueue).toHaveBeenCalledTimes(1);
  });
});

describe('ChannelsWebhookController: Telegram', () => {
  const update = (over: any = {}) => ({
    update_id: 501,
    message: {
      message_id: 7,
      chat: { id: 55, type: 'private' },
      from: { id: 55, is_bot: false, first_name: 'Ana', last_name: 'Ruiz' },
      text: 'hola',
      ...over,
    },
  });

  it('queues a private message when the secret header matches the salon\'s secret', async () => {
    const { ctrl, receptionist } = setup();
    const r = res();
    await ctrl.handleTelegram(TENANT, 'sekret', update(), r);
    expect(receptionist.enqueue).toHaveBeenCalledWith(TENANT, {
      channel: 'telegram',
      id: '501',
      from: '55',
      text: 'hola',
      hasAttachment: false,
      name: 'Ana Ruiz',
    });
    expect(r.json).toHaveBeenCalledWith({ received: true });
  });

  it('rejects a wrong secret', async () => {
    const { ctrl, receptionist } = setup();
    await expect(ctrl.handleTelegram(TENANT, 'nope!!', update(), res())).rejects.toBeInstanceOf(UnauthorizedException);
    expect(receptionist.enqueue).not.toHaveBeenCalled();
  });

  it('rejects updates for a salon with no bot connected', async () => {
    const { ctrl } = setup({ telegram: null });
    await expect(ctrl.handleTelegram(TENANT, 'sekret', update(), res())).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('ignores group chats', async () => {
    const { ctrl, receptionist } = setup();
    await ctrl.handleTelegram(TENANT, 'sekret', update({ chat: { id: -100, type: 'group' } }), res());
    expect(receptionist.enqueue).not.toHaveBeenCalled();
  });

  it('marks a photo or voice note as an attachment', async () => {
    const { ctrl, receptionist } = setup();
    await ctrl.handleTelegram(TENANT, 'sekret', update({ text: undefined, voice: { file_id: 'x' } }), res());
    expect(receptionist.enqueue).toHaveBeenCalledWith(TENANT, expect.objectContaining({ hasAttachment: true, text: undefined }));
  });

  it('drops the message when the salon lacks the multichannel feature', async () => {
    const { ctrl, receptionist } = setup({ multichannel: false });
    await ctrl.handleTelegram(TENANT, 'sekret', update(), res());
    expect(receptionist.enqueue).not.toHaveBeenCalled();
  });
});
