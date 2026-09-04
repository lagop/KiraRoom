import { ChannelsConfigService } from './channels-config.service';
import { UpdateChannelsConfigDto } from '@kira/shared';

/**
 * L-4 spec: pin the contract of ChannelsConfigService.
 *
 *  - read returns a redacted view (no secrets echoed back)
 *  - update merges partial DTOs into Tenant.features.multichannel
 *  - secrets are preserved unless explicitly nullified
 *  - 'web' is always present in enabledChannels after a save
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
  });

  it('redacts pageAccessToken and botToken on read', async () => {
    const { prisma } = makePrisma({
      multichannel: {
        enabledChannels: ['web', 'facebook', 'instagram', 'telegram'],
        meta: {
          pageId: '1234567890',
          pageAccessToken: 'EAAxxxx-secret',
          instagramBusinessAccountId: '0987654321',
          linkedChats: ['psid-1'],
        },
        telegram: {
          botToken: '123456:ABCDEF-secret',
          linkedChats: ['99'],
        },
      },
    });
    const svc = new ChannelsConfigService(prisma);
    const view = await svc.getConfig('t-1');
    expect(view.meta?.hasAccessToken).toBe(true);
    expect(view.meta?.pageId).toBe('1234567890');
    expect((view.meta as any).pageAccessToken).toBeUndefined();
    expect(view.telegram?.hasBotToken).toBe(true);
    expect((view.telegram as any).botToken).toBeUndefined();
  });

  it('merges a partial DTO into existing multichannel config without wiping', async () => {
    const { prisma, state } = makePrisma({
      multichannel: {
        enabledChannels: ['web'],
        meta: { pageId: '1234567890', pageAccessToken: 'EAA-old' },
      },
    });
    const svc = new ChannelsConfigService(prisma);
    const dto: UpdateChannelsConfigDto = {
      enabledChannels: ['facebook', 'instagram'],
    };
    await svc.updateConfig('t-1', dto);
    expect(prisma.tenant.update).toHaveBeenCalledTimes(1);
    const updated = state.features.multichannel;
    // 'web' should be auto-added
    expect(updated.enabledChannels).toEqual(
      expect.arrayContaining(['web', 'facebook', 'instagram']),
    );
    // Existing meta must be preserved (no token wipe)
    expect(updated.meta.pageId).toBe('1234567890');
    expect(updated.meta.pageAccessToken).toBe('EAA-old');
  });

  it('saves a new Meta config when none existed before', async () => {
    const { prisma, state } = makePrisma({});
    const svc = new ChannelsConfigService(prisma);
    await svc.updateConfig('t-1', {
      enabledChannels: ['facebook', 'instagram'],
      meta: {
        pageId: '1111111111',
        pageAccessToken: 'EAA-new',
        linkedChats: [],
      },
    });
    expect(state.features.multichannel.meta.pageId).toBe('1111111111');
    expect(state.features.multichannel.meta.pageAccessToken).toBe('EAA-new');
    expect(state.features.multichannel.enabledChannels).toEqual(
      expect.arrayContaining(['web', 'facebook', 'instagram']),
    );
  });

  it('saves a new Telegram config when none existed before', async () => {
    const { prisma, state } = makePrisma({});
    const svc = new ChannelsConfigService(prisma);
    await svc.updateConfig('t-1', {
      enabledChannels: ['telegram'],
      telegram: { botToken: '1234567890:ABCDEFGHIJKLMNOPQRSTUVWXYZ-_' },
    });
    expect(state.features.multichannel.telegram.botToken).toMatch(/^1234567890:/);
    expect(state.features.multichannel.enabledChannels).toEqual(
      expect.arrayContaining(['web', 'telegram']),
    );
  });

  it('throws if the tenant does not exist', async () => {
    const prisma = {
      tenant: {
        findUnique: jest.fn(async () => null),
      },
    } as any;
    const svc = new ChannelsConfigService(prisma);
    await expect(svc.getConfig('missing')).rejects.toThrow(/not found/);
  });
});