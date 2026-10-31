import { LLMProvider } from '@kira/shared';
import { LLMService } from './llm.service';

/**
 * The receptionist is told the salon's upcoming closures on the user turn,
 * next to the clock: the system prompt stays byte-stable for the cache
 * prefix, and nothing about a professional's absence reaches the model.
 * No LLM is called: the provider is a stub that records what it was sent.
 */
function setup(closures: unknown[]) {
  const sent: Array<{ system: string; turn: string }> = [];
  const provider = {
    generateCompletion: jest.fn(async (system: string, _history: unknown[], _config: unknown, turn: string) => {
      sent.push({ system, turn });
      return { id: 'r', text: 'ok', usage: {} };
    }),
  };
  const providerFactory: any = { createProvider: () => provider };
  const config: any = { get: (): undefined => undefined };
  const prisma = {
    tenant: {
      findFirst: jest.fn(async () => ({
        id: 'tenant-1',
        name: 'Salon Prueba',
        slug: 'salon-prueba',
        language: 'es',
        timezone: 'Europe/Madrid',
        openingHours: {},
        services: [],
        professionals: [],
        customDomain: null,
      })),
    },
    timeOff: { findMany: jest.fn(async () => closures) },
  };
  const faqs: any = { getFAQs: async () => [] };
  const flags: any = { isFeatureUnlocked: async () => false };
  const platform: any = { resolveEffective: async () => ({ provider: LLMProvider.ANTHROPIC, model: 'm' }) };
  const usage: any = { record: jest.fn() };
  const service = new LLMService(providerFactory, config, prisma as any, faqs, flags, platform, usage);
  return { service, prisma, sent };
}

describe('the receptionist knows the salon closures', () => {
  beforeEach(() => jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate'] }).setSystemTime(new Date('2026-10-31T09:00:00Z')));
  afterEach(() => jest.useRealTimers());

  const CHRISTMAS = {
    startDate: new Date('2026-12-24T00:00:00Z'),
    endDate: new Date('2026-12-26T00:00:00Z'),
    startTime: null,
    endTime: null,
  };

  it('puts them on the user turn, after the clock, and leaves the system prompt alone', async () => {
    const withClosure = setup([CHRISTMAS]);
    const without = setup([]);

    await withClosure.service.generateResponse('¿Abrís el 24 de diciembre?', [], 'tenant-1');
    await without.service.generateResponse('¿Abrís el 24 de diciembre?', [], 'tenant-1');

    const [a] = withClosure.sent;
    const [b] = without.sent;
    expect(a.turn).toMatch(/^\[Ahora en el salón: [^\n]*\]\n\[Cierres del salón en los próximos 60 días: /);
    expect(a.turn).toContain('Cerrado del 24 al 26 de diciembre (2026-12-24 a 2026-12-26)');
    expect(a.turn.endsWith('\n¿Abrís el 24 de diciembre?')).toBe(true);
    expect(a.system).not.toContain('Cerrado');
    expect(a.system).toBe(b.system);
    // A salon with no closures sends the turn exactly as before.
    expect(b.turn).not.toContain('Cierres del salón');
    expect(b.turn).toMatch(/^\[Ahora en el salón: [^\n]*\]\n¿Abrís/);
  });

  it('asks only for the salon closures, and only for their dates and hours', async () => {
    const { service, prisma } = setup([CHRISTMAS]);

    await service.generateResponse('hola', [], 'tenant-1');

    const args = (prisma.timeOff.findMany.mock.calls[0] as any[])[0];
    expect(args.where).toMatchObject({ tenantId: 'tenant-1', professionalId: null, status: 'approved' });
    expect(args.select).toEqual({ startDate: true, endDate: true, startTime: true, endTime: true });
    // A margin of a day either side of the 60-day window; the notice cuts it.
    expect(args.where.endDate.gte).toEqual(new Date('2026-10-30T00:00:00.000Z'));
    expect(args.where.startDate.lte).toEqual(new Date('2026-12-31T00:00:00.000Z'));
  });

  it('answers without the notice when the closures cannot be read', async () => {
    const { service, prisma, sent } = setup([]);
    prisma.timeOff.findMany.mockRejectedValueOnce(new Error('db down'));

    await service.generateResponse('hola', [], 'tenant-1');

    expect(sent).toHaveLength(1);
    expect(sent[0].turn).not.toContain('Cierres del salón');
  });

  it('is not added to the staff copilot, which has its own prompt', async () => {
    const { service, sent } = setup([CHRISTMAS]);

    await service.generateResponse('hola', [], 'tenant-1', undefined, { systemPromptOverride: 'copilot' });

    expect(sent[0].turn).not.toContain('Cierres del salón');
  });
});
