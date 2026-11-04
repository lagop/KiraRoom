import { Reflector } from '@nestjs/core';
import { AiFairUseResetScheduler } from '../../virtual-receptionist/schedulers/ai-fair-use-reset.scheduler';
import { VirtualReceptionistModule } from '../../virtual-receptionist/virtual-receptionist.module';
import { AiConversationCounterService } from '../../virtual-receptionist/services/ai-conversation-counter.service';
import { aiUsagePeriod, aiUsageThisMonth, incrementAiUsage, nextAiUsagePeriodStart } from './ai-monthly-usage';

/**
 * The monthly AI count could never reset: its scheduler was not registered
 * and nothing else zeroed `Tenant.aiConversationsUsed`, so salons were
 * capped on usage since signup. The count now carries its month.
 */
describe('AI monthly usage', () => {
  const nov = new Date('2026-11-30T23:59:00Z');
  const dec = new Date('2026-12-01T00:00:00Z');

  it('belongs to a UTC month', () => {
    expect(aiUsagePeriod(nov)).toBe('2026-11');
    expect(aiUsagePeriod(dec)).toBe('2026-12');
    expect(nextAiUsagePeriodStart(nov).toISOString()).toBe('2026-12-01T00:00:00.000Z');
  });

  it("reads another month's count, or one with no month, as 0", () => {
    expect(aiUsageThisMonth({ aiConversationsUsed: 480, aiConversationsPeriod: '2026-11' }, nov)).toBe(480);
    expect(aiUsageThisMonth({ aiConversationsUsed: 480, aiConversationsPeriod: '2026-11' }, dec)).toBe(0);
    // Counted before this change: cumulative since signup.
    expect(aiUsageThisMonth({ aiConversationsUsed: 5000, aiConversationsPeriod: null }, nov)).toBe(0);
    expect(aiUsageThisMonth(null, nov)).toBe(0);
  });

  it('increments in one statement that restarts on a new month', async () => {
    const queryRaw = jest.fn(async () => [{ used: 1 }]);
    const used = await incrementAiUsage({ $queryRaw: queryRaw } as any, 'tenant-1', 1, dec);
    expect(used).toBe(1);
    const [strings, ...values] = queryRaw.mock.calls[0] as unknown as [TemplateStringsArray, ...unknown[]];
    const sql = strings.join('?');
    expect(sql).toMatch(/CASE WHEN "aiConversationsPeriod" = \?\s+THEN "aiConversationsUsed" \+ \?::int ELSE \?::int END/);
    expect(values).toEqual(['2026-12', 1, 1, '2026-12', 'tenant-1']);
  });

  it('a missed reset does not carry usage over: a new month allows the salon again', async () => {
    const row = {
      plan: 'esencial',
      subscriptionStatus: 'active',
      trialEnd: null,
      maxLocations: 1,
      tenantAddOns: [],
      aiConversationsUsed: 500,
      aiConversationsPeriod: '2020-01',
      aiMessagesToday: 0,
      aiMessagesDay: null,
      aiFairUseAction: 'degrade',
    };
    const prisma: any = { tenant: { findUnique: jest.fn(async () => row) } };
    const subs: any = { aiCap: () => 500 };
    const svc = new AiConversationCounterService(prisma, { get: () => undefined } as any, subs, {
      counter: () => ({ inc: () => undefined }),
    } as any);

    const decision = await svc.evaluate('tenant-1');

    expect(decision.used).toBe(0);
    expect(decision.allowed).toBe(true);
  });

  it('the monthly reset job is registered, runs on the 1st in UTC, and writes the month', async () => {
    const providers: unknown[] = Reflect.getMetadata('providers', VirtualReceptionistModule);
    expect(providers).toContain(AiFairUseResetScheduler);

    const cron = new Reflector().get('SCHEDULE_CRON_OPTIONS', AiFairUseResetScheduler.prototype.resetForNewMonth);
    expect(cron).toMatchObject({ cronTime: '30 0 1 * *', timeZone: 'UTC' });

    const update = jest.fn(async () => ({}));
    const prisma: any = { tenant: { findMany: async () => [{ id: 't1' }, { id: 't2' }], update } };
    const counter = new AiConversationCounterService(prisma, { get: () => undefined } as any, {} as any, {} as any);
    await new AiFairUseResetScheduler(prisma, counter).resetAllTenants(dec);

    expect(update).toHaveBeenCalledTimes(2);
    expect(update).toHaveBeenCalledWith({
      where: { id: 't1' },
      data: {
        aiConversationsUsed: 0,
        aiConversationsPeriod: '2026-12',
        aiConversationsResetAt: new Date('2027-01-01T00:00:00Z'),
      },
    });
  });
});
