import { ChannelsConfigService } from './channels-config.service';

/**
 * L-4 spec: pin the contract of ChannelsConfigService.
 *
 *  - read returns a redacted view (no token, encrypted or not, is echoed)
 *  - update only changes the on/off switches: credentials used to be merged
 *    from the request body into the JSON in clear text, and now come only
 *    from ChannelConnectionsService (encrypted)
 *  - 'web' is always present in enabledChannels after a save
 *  - connections saved by the first version are flagged for reconnection:
 *    they were never subscribed to Meta's webhook / Telegram's setWebhook
 */

function makePrisma(initialFeatures: any = {}) {
  const state: any = { features: initialFeatures };
  return {
    prisma: {
      tenant: {
        findUnique: jest.fn(async () => ({ id: 't-1', features: state.features })),
        update: jest.fn(async ({ data }: any) => {
          state.features = data.features;
          return { id: 't-1', features: state.features };
        }),
      },
    },
    state,
  } as any;
}

describe('ChannelsConfigService (H-4)', () => {
  it('returns an empty default view when features.multichannel is missing', async () => {
    const { prisma } = makePrisma({});
    const svc = new ChannelsConfigService(prisma);
    const view = await svc.getConfig('t-1');
    expect(view.enabled).toBe(true);
    expect(view.enabledChannels).toEqual(['web', 'whatsapp']);
    expect(view.meta).toBeNull();
    expect(view.telegram).toBeNull();
    expect(view.metaPagesPending).toBe(false);
  });

  it('shows the connected Page, Instagram account and bot, never a token', async () => {
    const { prisma } = makePrisma({
      multichannel: {
        enabledChannels: ['web', 'facebook', 'instagram', 'telegram'],
        meta: {
          pageId: '1234567890',
          pageName: 'Salón Lucía',
          instagramBusinessAccountId: '17841400000',
          instagramUsername: 'salonlucia',
          pageAccessTokenEnc: 'v1:cipher',
        },
        telegram: { botId: '42', botUsername: 'salon_lucia_bot', botTokenEnc: 'v1:cipher2', webhookSecret: 'abc' },
      },
    });
    const view = await new ChannelsConfigService(prisma).getConfig('t-1');
    expect(view.meta).toEqual({
      configured: true,
      pageId: '1234567890',
      pageName: 'Salón Lucía',
      instagramBusinessAccountId: '17841400000',
      instagramUsername: 'salonlucia',
      hasAccessToken: true,
      needsReconnect: false,
    });
    expect(view.telegram).toEqual({
      configured: true,
      botUsername: 'salon_lucia_bot',
      hasBotToken: true,
      needsReconnect: false,
    });
    expect(JSON.stringify(view)).not.toMatch(/cipher|abc/);
  });

  it('flags clear-text credentials from the first version for reconnection, without echoing them', async () => {
    const { prisma } = makePrisma({
      multichannel: {
        meta: { pageId: '1234567890', pageAccessToken: 'EAAxxxx-secret' },
        telegram: { botToken: '123456:ABCDEF-secret' },
      },
    });
    const view = await new ChannelsConfigService(prisma).getConfig('t-1');
    expect(view.meta?.needsReconnect).toBe(true);
    expect(view.telegram?.needsReconnect).toBe(true);
    expect(JSON.stringify(view)).not.toMatch(/secret/);
  });

  it('says when Facebook Login left Pages to choose from, until they expire', async () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    const past = new Date(Date.now() - 60_000).toISOString();
    const pending = (expiresAt: string) => makePrisma({ multichannel: { metaPending: { expiresAt, pages: [] } } }).prisma;
    expect((await new ChannelsConfigService(pending(future)).getConfig('t-1')).metaPagesPending).toBe(true);
    expect((await new ChannelsConfigService(pending(past)).getConfig('t-1')).metaPagesPending).toBe(false);
  });

  it('changes the switches and keeps the stored connection', async () => {
    const { prisma, state } = makePrisma({
      multichannel: {
        enabledChannels: ['web'],
        meta: { pageId: '1234567890', pageAccessTokenEnc: 'v1:cipher' },
      },
    });
    const svc = new ChannelsConfigService(prisma);
    await svc.updateConfig('t-1', { enabledChannels: ['facebook', 'instagram'] });
    const updated = state.features.multichannel;
    expect(updated.enabledChannels).toEqual(expect.arrayContaining(['web', 'facebook', 'instagram']));
    expect(updated.meta).toEqual({ pageId: '1234567890', pageAccessTokenEnc: 'v1:cipher' });
  });

  it('ignores credentials in the body (they are not part of the switches)', async () => {
    const { prisma, state } = makePrisma({});
    await new ChannelsConfigService(prisma).updateConfig('t-1', {
      enabledChannels: ['telegram'],
      telegram: { botToken: '1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ-_' },
    } as any);
    expect(state.features.multichannel.telegram).toBeUndefined();
  });

  it('throws if the tenant does not exist', async () => {
    const prisma = { tenant: { findUnique: jest.fn(async () => null) } } as any;
    const svc = new ChannelsConfigService(prisma);
    await expect(svc.getConfig('missing')).rejects.toThrow(/not found/);
  });
});
