import { CopilotRetentionScheduler, copilotRetentionCutoff } from './copilot-retention.scheduler';

/**
 * M4 / D2: Copilot conversations go after 90 days without activity, the
 * action records after a year. They used to be kept for ever.
 */
describe('CopilotRetentionScheduler (Copilot audit M4)', () => {
  const NOW = new Date('2026-11-14T03:50:00Z');

  it('deletes conversations idle for 90 days and actions older than a year', async () => {
    const prisma: any = {
      assistantConversation: {
        findMany: jest.fn(async () => [{ id: 'c-old' }]),
        deleteMany: jest.fn(async () => ({ count: 1 })),
      },
      actionApproval: {
        findMany: jest.fn(async () => [{ id: 'a-old' }, { id: 'a-older' }]),
        deleteMany: jest.fn(async () => ({ count: 2 })),
      },
    };
    const res = await new CopilotRetentionScheduler(prisma).purge(NOW);
    expect(res).toEqual({ conversations: 1, actions: 2 });
    expect(prisma.assistantConversation.findMany.mock.calls[0][0].where).toEqual({
      updatedAt: { lt: new Date('2026-08-16T03:50:00Z') },
    });
    expect(prisma.actionApproval.findMany.mock.calls[0][0].where).toEqual({
      createdAt: { lt: new Date('2025-11-14T03:50:00Z') },
    });
  });

  it('cutoffs', () => {
    expect(copilotRetentionCutoff(90, NOW).toISOString()).toBe('2026-08-16T03:50:00.000Z');
  });
});
