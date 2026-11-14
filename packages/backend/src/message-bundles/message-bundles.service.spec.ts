import { MessageBundlesService } from './message-bundles.service';

/**
 * consumeCredit reads the remaining balance from the UPDATE ... RETURNING
 * rows. It used $executeRaw, which returns only the row count: a consumed
 * credit then threw on result[0] and the SMS caller skipped the send.
 */
describe('MessageBundlesService.consumeCredit', () => {
  function build(rows: Array<{ creditsRemaining: number | string }>) {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue(rows),
      $executeRaw: jest.fn().mockResolvedValue(rows.length),
    } as any;
    const addons = { activeAddOnsForTenant: jest.fn().mockResolvedValue(['message_bundles']) } as any;
    const counter = { inc: jest.fn() };
    const metrics = { counter: jest.fn().mockReturnValue(counter) } as any;
    const platformStripe = { client: () => null } as any;
    return { svc: new MessageBundlesService(prisma, addons, metrics, platformStripe), prisma };
  }

  it('a consumed credit returns ok with the new balance', async () => {
    const { svc, prisma } = build([{ creditsRemaining: 41 }]);
    await expect(svc.consumeCredit({ tenantId: 't1', channel: 'sms_marketing' })).resolves.toEqual({
      ok: true,
      remaining: 41,
    });
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it('an empty wallet is no_credits, not an error', async () => {
    const { svc } = build([]);
    await expect(svc.consumeCredit({ tenantId: 't1', channel: 'sms_marketing' })).resolves.toEqual({
      ok: false,
      remaining: 0,
      reason: 'no_credits',
    });
  });

  it('a balance read back as a string is a number', async () => {
    const { svc } = build([{ creditsRemaining: '7' }]);
    const res = await svc.consumeCredit({ tenantId: 't1', channel: 'whatsapp_marketing' });
    expect(res.remaining).toBe(7);
  });
});
