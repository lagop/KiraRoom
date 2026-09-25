import { ChannelsWebhookController } from './channels-webhook.controller';
import { FeatureFlagService } from '../common/feature-flags/feature-flag.service';

/**
 * H-4: webhook gate. Verify that when a tenant has the multichannel
 * pageId/linkedChats configured but lacks the `multichannel` feature
 * key (e.g. an Esencial tenant who was migrated from Pro), the
 * webhook silently drops the message and does NOT call
 * `whatsapp.processInbound`.
 */

function makePrisma(rowsById: Record<string, any>) {
  return {
    tenant: {
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => Object.values(rowsById)),
    },
  } as any;
}

/**
 * These tests exercise the multichannel gate, not signature verification.
 * With no META_APP_SECRET the handler skips the HMAC check outside
 * production, which is the path under test here.
 */
const stubConfig = () => ({ get: () => undefined }) as any;

describe('ChannelsWebhookController H-4 multichannel gate', () => {
  const mockWhatsapp = {
    processInbound: jest.fn().mockResolvedValue(undefined),
  } as any;
  const mockTelegram = {
    parseInbound: jest.fn(async () => ({
      externalUserId: '99',
      providerConversationId: '99',
      text: 'hola',
      channel: 'telegram',
      metadata: {},
      isFromUser: true,
    })),
  } as any;
  const fakeMetrics = {
    counter: () => ({ inc: () => undefined }),
  } as any;

  beforeEach(() => {
    mockWhatsapp.processInbound.mockClear();
  });

  it('drops a Meta message when tenant lacks the multichannel feature', async () => {
    // WhatsAppConnection index maps pageId -> tenant id
    const prisma = makePrisma({});
    prisma.whatsAppConnection = {
      findMany: jest.fn(async () => [{ tenantId: 't-1', phoneNumberId: '999' }]),
    };
    const flags = {
      isEnabled: jest.fn(async (tid: string, key: string) => {
        if (key === 'multichannel') return false; // gated
        return true;
      }),
    } as any;
    const ctrl = new ChannelsWebhookController(
      prisma,
      stubConfig(),
      mockWhatsapp,
      mockTelegram,
      flags,
      fakeMetrics,
    );
    const res = {
      json: jest.fn(),
      status: jest.fn().mockReturnThis(),
    } as any;
    const req = { headers: {} } as any;
    const body = {
      object: 'page',
      entry: [
        {
          id: '999',
          messaging: [
            { sender: { id: 'psid-1' }, message: { mid: 'm1', text: 'hola' } },
          ],
        },
      ],
    };
    await ctrl.handleMeta(body, req, res);
    expect(mockWhatsapp.processInbound).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it('processes a Meta message when tenant has the multichannel feature', async () => {
    const prisma = makePrisma({});
    prisma.whatsAppConnection = {
      findMany: jest.fn(async () => [{ tenantId: 't-2', phoneNumberId: '888' }]),
    };
    const flags = {
      isEnabled: jest.fn(async (_tid: string, key: string) => key === 'multichannel'),
    } as any;
    const ctrl = new ChannelsWebhookController(
      prisma,
      stubConfig(),
      mockWhatsapp,
      mockTelegram,
      flags,
      fakeMetrics,
    );
    const res = { json: jest.fn() } as any;
    const req = { headers: {} } as any;
    const body = {
      object: 'page',
      entry: [
        {
          id: '888',
          messaging: [
            { sender: { id: 'psid-2' }, message: { mid: 'm2', text: 'hola' } },
          ],
        },
      ],
    };
    await ctrl.handleMeta(body, req, res);
    expect(mockWhatsapp.processInbound).toHaveBeenCalledTimes(1);
    expect(mockWhatsapp.processInbound.mock.calls[0][0]).toMatchObject({
      tenantId: 't-2',
      channel: 'facebook',
      text: 'hola',
    });
  });

  it('drops a Telegram message when tenant lacks the multichannel feature', async () => {
    const prisma = makePrisma({
      t_3: { id: 't-3', features: { multichannel: { telegram: { linkedChats: ['55'] } } } },
    });
    const flags = {
      isEnabled: jest.fn(async (_tid: string, key: string) =>
        key === 'multichannel' ? false : true,
      ),
    } as any;
    const ctrl = new ChannelsWebhookController(
      prisma,
      stubConfig(),
      mockWhatsapp,
      mockTelegram,
      flags,
      fakeMetrics,
    );
    const res = { json: jest.fn() } as any;
    const req = { headers: { 'x-telegram-bot-api-secret-token': 'x' } } as any;
    const body = {
      message: { chat: { id: 55 }, text: 'hola' },
    };
    // Token lookup will iterate tenants; since linkedChats include '55', it
    // will find t-3 but the gate will drop it.
    await ctrl.handleTelegram('x', body, req, res);
    expect(mockWhatsapp.processInbound).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith({ received: true });
  });

  it('fails closed (drops message) if feature lookup throws', async () => {
    const prisma = makePrisma({});
    prisma.whatsAppConnection = {
      findMany: jest.fn(async () => [{ tenantId: 't-x', phoneNumberId: '777' }]),
    };
    const flags = {
      isEnabled: jest.fn(async () => {
        throw new Error('db down');
      }),
    } as any;
    const ctrl = new ChannelsWebhookController(
      prisma,
      stubConfig(),
      mockWhatsapp,
      mockTelegram,
      flags,
      fakeMetrics,
    );
    const res = { json: jest.fn() } as any;
    const req = { headers: {} } as any;
    const body = {
      object: 'page',
      entry: [
        {
          id: '777',
          messaging: [
            { sender: { id: 'psid-x' }, message: { mid: 'mx', text: 'hola' } },
          ],
        },
      ],
    };
    await ctrl.handleMeta(body, req, res);
    expect(mockWhatsapp.processInbound).not.toHaveBeenCalled();
  });
});