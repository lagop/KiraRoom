import { runUnscoped, tenantStorage } from './tenant.context';

/** A lazy query, like Prisma's: it only runs when someone calls .then(). */
const lazyQuery = (seen: Array<boolean | undefined>) => ({
  then(resolve: (v: string) => void) {
    seen.push(tenantStorage.getStore()?.bypass);
    resolve('done');
  },
});

describe('runUnscoped', () => {
  it('starts a lazy query inside the unscoped context, not later in the salon one', async () => {
    const seen: Array<boolean | undefined> = [];
    const result = await tenantStorage.run({ tenantId: 'salon-a', bypass: false }, async () =>
      runUnscoped(() => lazyQuery(seen) as unknown as Promise<string>),
    );
    expect(result).toBe('done');
    expect(seen).toEqual([true]);
  });

  it('passes a plain value through and keeps the async form working', async () => {
    expect(runUnscoped(() => 7)).toBe(7);
    await expect(runUnscoped(async () => tenantStorage.getStore()?.bypass)).resolves.toBe(true);
  });

  it('propagates a rejection', async () => {
    await expect(runUnscoped(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  });
});

describe("EmailCampaignSender.kick (audit 2026-11-06)", () => {
  it("runs the dispatch outside the salon whose request kicked it", async () => {
    const { EmailCampaignSender } = await import("../../email-campaigns/email-campaign-sender.service");
    const seen: Array<boolean | undefined> = [];
    const sender: any = Object.create(EmailCampaignSender.prototype);
    sender.dispatch = async () => {
      seen.push(tenantStorage.getStore()?.bypass);
    };
    await tenantStorage.run({ tenantId: "salon-a", bypass: false }, async () => {
      sender.kick();
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));
    });
    expect(seen).toEqual([true]);
  });
});
