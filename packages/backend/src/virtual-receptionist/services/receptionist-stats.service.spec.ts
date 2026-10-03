import { ReceptionistStatsService } from './receptionist-stats.service';

/**
 * GET /virtual-receptionist/stats returned fixed numbers (avgResponseTime
 * 1500, handoffRate 15.2, faqHitRate 35.8, bookings 0) next to counts for no
 * tenant, and the channels page showed process-wide counters as the salon's
 * own. These pin that every figure is a query on the caller's tenant and
 * that nothing is filled in when there is no data.
 */
function prismaWith(opts: {
  channels?: Array<{ channel: string; n: number }>;
  roles?: Array<{ role: string; n: number }>;
  handedOff?: number;
  contexts?: unknown[];
  avg?: number | null;
}) {
  return {
    chatConversation: {
      groupBy: jest.fn().mockResolvedValue((opts.channels ?? []).map((c) => ({ channel: c.channel, _count: { id: c.n } }))),
      count: jest.fn().mockResolvedValue(opts.handedOff ?? 0),
      findMany: jest.fn().mockResolvedValue((opts.contexts ?? []).map((context) => ({ context }))),
    },
    chatMessage: {
      groupBy: jest.fn().mockResolvedValue((opts.roles ?? []).map((r) => ({ role: r.role, _count: { id: r.n } }))),
      aggregate: jest.fn().mockResolvedValue({ _avg: { responseTime: opts.avg ?? null } }),
    },
  } as any;
}

describe('ReceptionistStatsService', () => {
  it('counts the tenant\'s conversations, messages, bookings and handoffs', async () => {
    const prisma = prismaWith({
      channels: [
        { channel: 'web', n: 7 },
        { channel: 'whatsapp', n: 3 },
      ],
      roles: [
        { role: 'user', n: 40 },
        { role: 'assistant', n: 38 },
      ],
      handedOff: 2,
      contexts: [{ chatBookings: 1 }, { chatBookings: 2 }, { chatBookings: 'x' }, null],
      avg: 2345.6,
    });
    const stats = await new ReceptionistStatsService(prisma).forTenant('t-1', 30);

    expect(stats).toMatchObject({
      days: 30,
      conversations: 10,
      byChannel: { web: 7, whatsapp: 3, facebook: 0, instagram: 0, telegram: 0 },
      messages: { fromClients: 40, fromReceptionist: 38 },
      bookings: 3,
      handedOff: 2,
      avgResponseMs: 2346,
    });
    expect(stats).not.toHaveProperty('faqHitRate');

    // Every query is the caller's tenant.
    expect(prisma.chatConversation.groupBy.mock.calls[0][0].where.tenantId).toBe('t-1');
    expect(prisma.chatConversation.count.mock.calls[0][0].where.tenantId).toBe('t-1');
    expect(prisma.chatConversation.findMany.mock.calls[0][0].where.tenantId).toBe('t-1');
    expect(prisma.chatMessage.groupBy.mock.calls[0][0].where.conversation).toEqual({ tenantId: 't-1' });
    expect(prisma.chatMessage.aggregate.mock.calls[0][0].where.conversation).toEqual({ tenantId: 't-1' });
  });

  it('reports no response time instead of inventing one, and zeros with no data', async () => {
    const stats = await new ReceptionistStatsService(prismaWith({})).forTenant('t-1');
    expect(stats).toMatchObject({
      days: 30,
      conversations: 0,
      messages: { fromClients: 0, fromReceptionist: 0 },
      bookings: 0,
      handedOff: 0,
      avgResponseMs: null,
    });
  });

  it('keeps the window between 1 and 365 days', async () => {
    const svc = new ReceptionistStatsService(prismaWith({}));
    expect((await svc.forTenant('t-1', 5000)).days).toBe(365);
    expect((await svc.forTenant('t-1', 0)).days).toBe(30);
    expect((await svc.forTenant('t-1', Number.NaN)).days).toBe(30);
    expect((await svc.forTenant('t-1', 7)).days).toBe(7);
  });
});
