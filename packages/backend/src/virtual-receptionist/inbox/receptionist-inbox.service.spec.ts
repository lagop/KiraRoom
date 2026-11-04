import { NotFoundException } from '@nestjs/common';
import { asksForPerson, ReceptionistInboxService } from './receptionist-inbox.service';
import { refusesPromotions } from '../tools/receptionist-booking';

/**
 * Conversaciones (audit D15): the salon reads its receptionist conversations,
 * pauses the assistant in one, and is told when a client needs it.
 */

const TENANT = 't-1';
const ACTOR = { id: 'u-owner', role: 'owner' as any, tenantId: TENANT };

function setup(opts: { conversation?: any; claimed?: number; emailOn?: boolean } = {}) {
  const conversation = opts.conversation ?? {
    id: 'c-1',
    channel: 'whatsapp',
    createdAt: new Date(),
    lastActivityAt: new Date(),
    attentionReason: null,
    attentionAt: null,
    assistantPausedAt: null,
    context: { visitorKey: 'whatsapp-34600111222' },
    client: null,
    messages: [],
  };
  const prisma: any = {
    chatConversation: {
      findFirst: jest.fn(async ({ where }: any) => (where.tenantId === TENANT && where.id === conversation.id ? conversation : null)),
      findMany: jest.fn(async () => [{ ...conversation, totalMessages: 3, messages: [{ role: 'user', content: 'Hola', createdAt: new Date() }] }]),
      count: jest.fn(async () => 1),
      updateMany: jest.fn(async () => ({ count: opts.claimed ?? 1 })),
    },
    user: {
      findMany: jest.fn(async () => [
        { id: 'u-owner', email: 'owner@salon.test', firstName: 'Ana' },
        { id: 'u-admin', email: null, firstName: 'Luis' },
      ]),
    },
  };
  const audit = { record: jest.fn(async (_a: string, _p: any) => ({ id: 'a' })) };
  const notifications = { create: jest.fn(async (_n: any) => ({})) };
  const email = { isConfigured: () => opts.emailOn ?? true, sendEmail: jest.fn(async (_e: any) => ({ success: true })) };
  const svc = new ReceptionistInboxService(prisma, audit as any, notifications as any, email as any);
  return { svc, prisma, audit, notifications, email };
}

describe('ReceptionistInboxService', () => {
  it('lists only the caller salon, with filters, and names a WhatsApp sender by number', async () => {
    const { svc, prisma } = setup();
    const out = await svc.list(TENANT, { view: 'attention', channel: 'whatsapp', q: 'cita', page: 2 });

    const args = prisma.chatConversation.findMany.mock.calls[0][0];
    expect(args.where).toMatchObject({ tenantId: TENANT, attentionAt: { not: null }, channel: 'whatsapp' });
    expect(args.where.OR[0]).toEqual({ messages: { some: { content: { contains: 'cita', mode: 'insensitive' } } } });
    expect(args.skip).toBe(30);
    expect(out.items[0]).toMatchObject({ id: 'c-1', name: '+34600111222', paused: false, lastMessage: { preview: 'Hola' } });
  });

  it("does not open another salon's conversation", async () => {
    const { svc } = setup();
    await expect(svc.get('t-other', 'c-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(svc.pause({ ...ACTOR, tenantId: 't-other' }, 'c-1')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('pauses and resumes in the salon, and audits who did it', async () => {
    const { svc, prisma, audit } = setup();
    await svc.pause(ACTOR, 'c-1');
    expect(prisma.chatConversation.updateMany.mock.calls[0][0]).toMatchObject({
      where: { id: 'c-1', tenantId: TENANT, assistantPausedAt: null },
      data: { assistantPausedById: 'u-owner' },
    });
    await svc.resume(ACTOR, 'c-1');
    expect(prisma.chatConversation.updateMany.mock.calls[1][0]).toEqual({
      where: { id: 'c-1', tenantId: TENANT },
      data: { assistantPausedAt: null, assistantPausedById: null },
    });
    expect(audit.record.mock.calls.map((c: any[]) => c[0])).toEqual([
      'receptionist.conversation_paused',
      'receptionist.conversation_resumed',
    ]);
  });

  it('tells the owner and admins once, in the panel and by email', async () => {
    const { svc, notifications, email, prisma } = setup();
    expect(await svc.flagAttention(TENANT, 'c-1', 'client_asked_person')).toBe(true);

    expect(prisma.chatConversation.updateMany.mock.calls[0][0].where).toEqual({ id: 'c-1', tenantId: TENANT, attentionAt: null });
    expect(prisma.user.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: TENANT, role: { in: ['owner', 'admin'] } });
    expect(notifications.create).toHaveBeenCalledTimes(2);
    expect(notifications.create.mock.calls[0][0]).toMatchObject({
      tenantId: TENANT,
      title: 'Una clienta quiere hablar con el salón',
      data: { kind: 'receptionist_attention', conversationId: 'c-1', link: '/dashboard/conversaciones?c=c-1' },
    });
    expect(notifications.create.mock.calls[0][0].message).toContain('+34600111222 ha pedido hablar con alguien del salón en WhatsApp');
    // Only the manager with an email gets one.
    expect(email.sendEmail).toHaveBeenCalledTimes(1);
    expect(email.sendEmail.mock.calls[0][0]).toMatchObject({ to: 'owner@salon.test' });
  });

  it('already told: no second notice until it is attended', async () => {
    const { svc, notifications, email } = setup({ claimed: 0 });
    expect(await svc.flagAttention(TENANT, 'c-1', 'assistant_could_not_answer')).toBe(false);
    expect(notifications.create).not.toHaveBeenCalled();
    expect(email.sendEmail).not.toHaveBeenCalled();
  });

  it('never throws into the reply', async () => {
    const { svc, prisma } = setup();
    prisma.chatConversation.updateMany.mockRejectedValue(new Error('db down'));
    await expect(svc.flagAttention(TENANT, 'c-1', 'client_asked_person')).resolves.toBe(false);
  });
});

describe('asksForPerson', () => {
  it('recognises a request for a person', () => {
    for (const m of ['Quiero hablar con una persona', '¿Puedo hablar con alguien del salón?', 'pásame con la encargada', 'I want to talk to a human', '¿Eres un robot?']) {
      expect({ m, hit: asksForPerson(m) }).toEqual({ m, hit: true });
    }
  });

  it('leaves ordinary questions alone', () => {
    for (const m of ['¿A qué hora abrís?', 'Quiero cita con Ana el martes', 'Hola', '¿Cuánto cuesta un tinte?']) {
      expect({ m, hit: asksForPerson(m) }).toEqual({ m, hit: false });
    }
  });
});

describe('refusesPromotions (D17)', () => {
  it('only her explicit no counts; the default records nothing', () => {
    expect(refusesPromotions('Sí, pero no quiero recibir promociones')).toBe(true);
    expect(refusesPromotions('sí, sin publicidad por favor')).toBe(true);
    expect(refusesPromotions('Sí')).toBe(false);
    expect(refusesPromotions('Sí, perfecto, gracias')).toBe(false);
    expect(refusesPromotions(undefined)).toBe(false);
  });
});
