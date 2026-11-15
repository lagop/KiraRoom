import { SalonCopilotToolsService } from './salon-copilot-tools';
import { conversationTitle } from '../assistant.service';

/**
 * find_client: a name typed in the chat becomes a clientId. Without it the
 * copilot asked the salon for the client's "ID de ficha".
 */

const CLIENTS = [
  { id: 'c-1', firstName: 'Marta', lastName: 'López', lastVisit: new Date('2026-09-01T00:00:00Z'), visitCount: 4, status: 'active' },
  { id: 'c-2', firstName: 'Marta', lastName: 'Ruiz', lastVisit: null, visitCount: 0, status: 'blocked' },
];

function makePrisma(found: Array<{ id: string }>) {
  const calls: Record<string, any[]> = { queryRaw: [], findMany: [], count: [], professional: [] };
  const prisma: any = {
    $queryRaw: jest.fn(async (sql: any) => {
      calls.queryRaw.push(sql);
      return found;
    }),
    client: {
      findMany: jest.fn(async (args: any) => {
        calls.findMany.push(args);
        return CLIENTS.filter((c) => args.where.id.in.includes(c.id));
      }),
      count: jest.fn(async (args: any) => {
        calls.count.push(args);
        return CLIENTS.filter((c) => args.where.id.in.includes(c.id)).length;
      }),
    },
    professional: {
      findFirst: jest.fn(async (args: any) => {
        calls.professional.push(args);
        return { id: 'pro-1' };
      }),
    },
  };
  return { prisma, calls };
}

const ctx = (prisma: any, role = 'owner') => ({ prisma, tenantId: 't-1', userId: 'u-1', role }) as any;

describe('find_client', () => {
  it('turns a name into the matching clients, without contact details', async () => {
    const { prisma, calls } = makePrisma([{ id: 'c-1' }, { id: 'c-2' }]);
    const svc = new SalonCopilotToolsService(prisma);
    const res: any = await svc.execute('find_client', { query: 'MARTA' }, ctx(prisma));

    expect(res.total).toBe(2);
    expect(res.matches).toEqual([
      { clientId: 'c-1', name: 'Marta López', lastVisit: '2026-09-01', visitCount: 4 },
      { clientId: 'c-2', name: 'Marta Ruiz', lastVisit: null, visitCount: 0, status: 'blocked' },
    ]);
    expect(JSON.stringify(res)).not.toMatch(/phone|email/);
    // Within the salon, the wizard's test client left out.
    expect(calls.findMany[0].where).toMatchObject({ tenantId: 't-1', isTest: false });
    // The search is accent and case folded, as in Clientas.
    expect(calls.queryRaw[0].values).toContain('%marta%');
  });

  it('applies the staff reach rule (only clients she has attended)', async () => {
    const { prisma, calls } = makePrisma([{ id: 'c-1' }]);
    const svc = new SalonCopilotToolsService(prisma);
    await svc.execute('find_client', { query: 'marta' }, ctx(prisma, 'staff'));
    expect(calls.professional).toHaveLength(1);
    expect(JSON.stringify(calls.findMany[0].where)).toContain('pro-1');
  });

  it('says so when nothing matches, and refuses an empty query', async () => {
    const { prisma } = makePrisma([]);
    const svc = new SalonCopilotToolsService(prisma);
    expect(await svc.execute('find_client', { query: 'zzz' }, ctx(prisma))).toEqual({ query: 'zzz', matches: [], total: 0 });
    expect(await svc.execute('find_client', { query: ' ' }, ctx(prisma))).toEqual({ error: 'missing_query' });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

describe('conversationTitle', () => {
  it('is the first question on one line', () => {
    expect(conversationTitle('  ¿Qué citas hay\nel martes?  ')).toBe('¿Qué citas hay el martes?');
  });

  it('cuts a long question at a word, at most 60 characters', () => {
    const title = conversationTitle('Redáctame un mensaje para una clienta que hace dos meses que no viene, invitándola a volver');
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith('…')).toBe(true);
    expect(title).toBe('Redáctame un mensaje para una clienta que hace dos meses…');
  });
});
