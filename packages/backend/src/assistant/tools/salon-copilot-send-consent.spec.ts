import { SalonCopilotToolsService, standardTemplateKind } from './salon-copilot-tools';

jest.mock('../../common/encryption/encryption.service', () => ({
  EncryptionService: class {
    decrypt() {
      return 'token-1';
    }
  },
}));

/**
 * The staff copilot's send_message sent any template to any client: a
 * campaign's promotion (kr_promo_*) went to clients who never opted in to
 * WhatsApp promotions, or had replied BAJA. And it sent the number as typed
 * in the client file ("600 111 222"). No real Meta call here: fetch is mocked.
 */

const TENANT_ID = 't-1';

function makePrisma(opts: { optedIn?: boolean; phone?: string } = {}): any {
  return {
    appointment: { findFirst: jest.fn(async () => ({ id: 'a-1' })) },
    client: {
      findFirst: jest.fn(async () => ({ id: 'c-1', tenantId: TENANT_ID, firstName: 'Carmen', phone: opts.phone ?? '600 111 222' })),
    },
    professional: { findFirst: jest.fn(async () => null) },
    tenant: { findUnique: jest.fn(async () => ({ country: 'ES' })) },
    whatsAppConnection: {
      findUnique: jest.fn(async () => ({
        tenantId: TENANT_ID,
        isActive: true,
        accessTokenEnc: 'enc',
        phoneNumberId: '999',
        wabaId: 'waba-1',
      })),
    },
    consent: {
      findMany: jest.fn(async () => (opts.optedIn ? [{ clientId: 'c-1', responses: { accepts: true } }] : [])),
    },
  };
}

const ctx = (prisma: any) => ({ prisma, tenantId: TENANT_ID, userId: 'u-1', role: 'owner' as const });

function mockMeta(category?: string) {
  return jest.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
    if (String(url).includes('/message_templates')) {
      return {
        ok: true,
        json: async () => ({ data: category ? [{ name: 'oferta_otono', category }] : [] }),
      } as any;
    }
    return { ok: true, json: async () => ({ messages: [{ id: 'wamid.1' }] }) } as any;
  });
}

afterEach(() => jest.restoreAllMocks());

describe('send_message and WhatsApp promotion consent', () => {
  it('tells templates apart by name where it can', () => {
    expect(standardTemplateKind('kr_promo_abc_1')).toBe('marketing');
    expect(standardTemplateKind('kiraroom_recordatorio_cita')).toBe('utility');
    expect(standardTemplateKind('oferta_otono')).toBe('unknown');
  });

  it('refuses a campaign template for a client without WhatsApp promotion opt-in (or who replied BAJA)', async () => {
    const fetch = mockMeta();
    const prisma = makePrisma({ optedIn: false });
    const res: any = await new SalonCopilotToolsService(prisma).execute(
      'send_message',
      { clientId: 'c-1', templateName: 'kr_promo_abc_1' },
      ctx(prisma),
    );
    expect(res.error).toBe('no_whatsapp_marketing_consent');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('refuses a template Meta files as MARKETING, and one whose category cannot be told', async () => {
    for (const category of ['MARKETING', undefined]) {
      const fetch = mockMeta(category);
      const prisma = makePrisma({ optedIn: false });
      const res: any = await new SalonCopilotToolsService(prisma).execute(
        'send_message',
        { clientId: 'c-1', templateName: 'oferta_otono' },
        ctx(prisma),
      );
      expect(res.error).toBe('no_whatsapp_marketing_consent');
      // Only the category lookup: nothing sent.
      expect(fetch.mock.calls.every((c: any[]) => String(c[0]).includes('/message_templates'))).toBe(true);
      jest.restoreAllMocks();
    }
  });

  it('sends a promotion to a client who opted in, to her number in international form', async () => {
    const fetch = mockMeta();
    const prisma = makePrisma({ optedIn: true });
    const res: any = await new SalonCopilotToolsService(prisma).execute(
      'send_message',
      { clientId: 'c-1', templateName: 'kr_promo_abc_1' },
      ctx(prisma),
    );
    expect(res.ok).toBe(true);
    const body = JSON.parse((fetch.mock.calls[0] as any[])[1].body);
    expect(body.to).toBe('34600111222');
  });

  it('sends an appointment notice (UTILITY) without promotion opt-in', async () => {
    const fetch = mockMeta();
    const prisma = makePrisma({ optedIn: false, phone: '+34 600-111-222' });
    const res: any = await new SalonCopilotToolsService(prisma).execute(
      'send_message',
      { clientId: 'c-1', templateName: 'kiraroom_recordatorio_cita' },
      ctx(prisma),
    );
    expect(res.ok).toBe(true);
    expect(prisma.consent.findMany).not.toHaveBeenCalled();
    expect(JSON.parse((fetch.mock.calls[0] as any[])[1].body).to).toBe('34600111222');
  });

  it('sends a template Meta files as UTILITY without promotion opt-in', async () => {
    const fetch = mockMeta('UTILITY');
    const prisma = makePrisma({ optedIn: false });
    const res: any = await new SalonCopilotToolsService(prisma).execute(
      'send_message',
      { clientId: 'c-1', templateName: 'oferta_otono' },
      ctx(prisma),
    );
    expect(res.ok).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
