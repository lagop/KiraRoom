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
