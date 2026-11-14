import { BadRequestException } from '@nestjs/common';
import { ActionApprovalService } from './action-approval.service';

/**
 * M1 (Copilot audit): an approval runs its action once. Two clicks, a retry
 * or two tabs used to read "pending" together and both run the tool (two
 * WhatsApps, the wait list told twice). The claim pending → approved is one
 * atomic write; only the call that wins it executes.
 */
function setup() {
  const row: any = {
    id: 'ap-1',
    userId: 'u-1',
    tenantId: 't-1',
    status: 'pending',
    toolName: 'send_message',
    toolInput: { clientId: 'c-1' },
    preview: 'Enviar un WhatsApp a Carmen R.',
    expiresAt: new Date(Date.now() + 60_000),
    resolvedAt: null,
    resultSnapshot: null,
  };
  const prisma: any = {
    actionApproval: {
      findUnique: jest.fn(async () => ({ ...row })),
      findUniqueOrThrow: jest.fn(async () => ({ ...row })),
      // Postgres' conditional UPDATE: only a row still matching the where.
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (where.status && row.status !== where.status) return { count: 0 };
        if (where.expiresAt?.gt && !(row.expiresAt > where.expiresAt.gt)) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
      update: jest.fn(async ({ data }: any) => Object.assign(row, data) && { ...row }),
    },
  };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const tools: any = {
    execute: jest.fn(async () => {
      await gate;
      return { ok: true };
    }),
  };
  const svc = new ActionApprovalService(prisma, tools);
  return { svc, tools, row, release };
}

const ctx = { tenantId: 't-1', role: 'owner', userId: 'u-1' };

describe('ActionApprovalService: one execution per approval (M1)', () => {
  it('two approvals at once run the tool once; the second is refused', async () => {
    const { svc, tools, release } = setup();
    const first = svc.approveAndExecute('ap-1', 'u-1', ctx);
    const second = svc.approveAndExecute('ap-1', 'u-1', ctx);
    await expect(second).rejects.toThrow(BadRequestException);
    release();
    await expect(first).resolves.toMatchObject({ status: 'executed' });
    expect(tools.execute).toHaveBeenCalledTimes(1);
  });

  it('a reject while it runs does not turn it into "rejected"', async () => {
    const { svc, row, release } = setup();
    const running = svc.approveAndExecute('ap-1', 'u-1', ctx);
    await new Promise((r) => setImmediate(r));
    await expect(svc.reject('ap-1', 'u-1')).rejects.toThrow('approval_not_pending:approved');
    release();
    await running;
    expect(row.status).toBe('executed');
  });
});
