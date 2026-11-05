import { salonTeamRecipients } from './salon-team-recipients';

function prismaWith(users: Array<{ id: string; role: string; tenantId?: string; isActive?: boolean }>) {
  const findMany = jest.fn(async ({ where }: any) =>
    users
      .filter((u) => (u.tenantId ?? 't-1') === where.tenantId)
      .filter((u) => where.role.in.includes(u.role))
      .filter((u) => (u.isActive ?? true) === where.isActive)
      .map((u) => ({ id: u.id })),
  );
  return { user: { findMany } };
}

const allowAll = { shouldSendNotificationForUser: jest.fn(async () => true) };

describe('salonTeamRecipients (I4)', () => {
  it('includes the owner, not only the admins', async () => {
    const prisma = prismaWith([
      { id: 'owner', role: 'owner' },
      { id: 'admin', role: 'admin' },
      { id: 'staff', role: 'staff' },
    ]);
    const out = await salonTeamRecipients(prisma as any, allowAll, 't-1', 'appointment_created', null);
    expect(out.map((u) => u.id).sort()).toEqual(['admin', 'owner']);
  });

  it('a salon with only an owner still gets the notice', async () => {
    const prisma = prismaWith([{ id: 'owner', role: 'owner' }]);
    const out = await salonTeamRecipients(prisma as any, allowAll, 't-1', 'appointment_cancelled');
    expect(out).toEqual([{ id: 'owner' }]);
  });

  it('skips the professional\'s own user (they get their own notice)', async () => {
    const prisma = prismaWith([
      { id: 'owner', role: 'owner' },
      { id: 'admin', role: 'admin' },
    ]);
    const out = await salonTeamRecipients(prisma as any, allowAll, 't-1', 'appointment_created', 'owner');
    expect(out).toEqual([{ id: 'admin' }]);
  });

  it('respects a user who turned the in-app notice off for that kind', async () => {
    const prisma = prismaWith([
      { id: 'owner', role: 'owner' },
      { id: 'admin', role: 'admin' },
    ]);
    const prefs = {
      shouldSendNotificationForUser: jest.fn(async (userId: string, type: string, channel: string) => {
        expect(channel).toBe('inApp');
        return !(userId === 'admin' && type === 'appointment_completed');
      }),
    };
    const out = await salonTeamRecipients(prisma as any, prefs, 't-1', 'appointment_completed');
    expect(out).toEqual([{ id: 'owner' }]);
  });

  it('leaves out deactivated accounts and other salons', async () => {
    const prisma = prismaWith([
      { id: 'owner', role: 'owner' },
      { id: 'gone', role: 'admin', isActive: false },
      { id: 'elsewhere', role: 'owner', tenantId: 't-2' },
    ]);
    const out = await salonTeamRecipients(prisma as any, allowAll, 't-1', 'appointment_no_show');
    expect(out).toEqual([{ id: 'owner' }]);
  });

  it('a failed preference lookup does not hide the notice', async () => {
    const prisma = prismaWith([{ id: 'owner', role: 'owner' }]);
    const prefs = { shouldSendNotificationForUser: jest.fn(async () => { throw new Error('db'); }) };
    const out = await salonTeamRecipients(prisma as any, prefs, 't-1', 'appointment_rescheduled');
    expect(out).toEqual([{ id: 'owner' }]);
  });
});
