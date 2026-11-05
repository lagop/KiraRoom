import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { AssistantService } from './assistant.service';

/**
 * I3: the panel sends to POST /assistant/messages with the conversation it
 * shows. The conversation must be the caller's own; "Nueva conversación"
 * starts an empty thread; the thumbs under a reply are stored.
 */

const USER = { id: 'u-1', tenantId: 't-1', role: 'owner' };

function conv(over: Partial<any> = {}) {
  return {
    id: 'c-1',
    tenantId: 't-1',
    userId: 'u-1',
    sessionId: null,
    title: null,
    createdAt: new Date('2026-11-03T08:00:00Z'),
    updatedAt: new Date('2026-11-03T08:00:00Z'),
    ...over,
  };
}

function setup(opts: { conversations?: any[]; messages?: any[]; feedback?: any[]; overCap?: boolean } = {}) {
  const conversations = opts.conversations ?? [conv()];
  const messages = opts.messages ?? [];
  const feedback = opts.feedback ?? [];
  const prisma: any = {
    assistantConversation: {
      findFirst: jest.fn(async ({ where }: any) =>
        conversations.find(
          (c) =>
            (where.id === undefined || c.id === where.id) &&
            c.userId === where.userId &&
            c.tenantId === where.tenantId &&
            (where.sessionId === undefined || c.sessionId === where.sessionId),
        ) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = conv({ id: `c-${conversations.length + 1}`, ...data });
        conversations.push(row);
        return row;
      }),
      update: jest.fn(async () => ({})),
    },
    assistantMessage: {
      create: jest.fn(async ({ data }: any) => ({
        id: 'm-new',
        toolName: null,
        toolInput: null,
        toolResult: null,
        pendingActionId: null,
        createdAt: new Date(),
        ...data,
      })),
      findFirst: jest.fn(async ({ where }: any) =>
        messages.find(
          (m) =>
            m.id === where.id &&
            m.role === where.role &&
            m.conversation.userId === where.conversation.userId &&
            m.conversation.tenantId === where.conversation.tenantId,
        ) ?? null,
      ),
    },
    copilotFeedback: {
      findFirst: jest.fn(async ({ where }: any) =>
        feedback.find((f) => f.messageId === where.messageId && f.userId === where.userId) ?? null,
      ),
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `f-${feedback.length + 1}`, createdAt: new Date(), ...data };
        feedback.push(row);
        return row;
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const row = feedback.find((f) => f.id === where.id);
        Object.assign(row, data);
        return row;
      }),
    },
  };
  const tiers: any = { isOverCostCap: jest.fn(async () => opts.overCap ?? true) };
  const svc = new AssistantService(prisma, {} as any, {} as any, {} as any, tiers);
  return { svc, prisma, conversations, feedback };
}

describe('AssistantService: the conversation a message goes to', () => {
  it('uses the conversation the panel names, when it is the caller\'s', async () => {
    const { svc, prisma } = setup({ conversations: [conv(), conv({ id: 'c-2' })] });
    // Over the cost cap: the reply is stored without calling the LLM.
    const res = await svc.sendMessage(USER, { content: 'hola', conversationId: 'c-2' });
    expect(res.conversation.id).toBe('c-2');
    expect(prisma.assistantMessage.create.mock.calls[0][0].data.conversationId).toBe('c-2');
  });

  it('refuses a conversation of another user', async () => {
    const { svc, prisma } = setup({ conversations: [conv({ id: 'c-9', userId: 'u-2' })] });
    await expect(svc.sendMessage(USER, { content: 'hola', conversationId: 'c-9' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    expect(prisma.assistantMessage.create).not.toHaveBeenCalled();
  });

  it('refuses a conversation of another salon', async () => {
    const { svc } = setup({ conversations: [conv({ id: 'c-9', tenantId: 't-2' })] });
    await expect(svc.sendMessage(USER, { content: 'hola', conversationId: 'c-9' })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('without an id, the persistent thread as before', async () => {
    const { svc } = setup();
    const res = await svc.sendMessage(USER, { content: 'hola' });
    expect(res.conversation.id).toBe('c-1');
  });

  it('"Nueva conversación" starts an empty thread', async () => {
    const { svc } = setup();
    const fresh = await svc.startConversation('u-1', 't-1');
    expect(fresh.id).not.toBe('c-1');
  });
});

describe('AssistantService.submitFeedback', () => {
  const reply = { id: 'm-1', role: 'assistant', conversation: { userId: 'u-1', tenantId: 't-1' } };

  it('stores a rating on the caller\'s own reply', async () => {
    const { svc, feedback } = setup({ messages: [reply] });
    const res = await svc.submitFeedback(USER, { messageId: 'm-1', rating: -1, comment: '  no era eso ' });
    expect(res.rating).toBe(-1);
    expect(feedback).toHaveLength(1);
    expect(feedback[0]).toMatchObject({ tenantId: 't-1', userId: 'u-1', messageId: 'm-1', comment: 'no era eso' });
  });

  it('a second vote replaces the first', async () => {
    const { svc, feedback } = setup({ messages: [reply] });
    await svc.submitFeedback(USER, { messageId: 'm-1', rating: -1 });
    await svc.submitFeedback(USER, { messageId: 'm-1', rating: 1 });
    expect(feedback).toHaveLength(1);
    expect(feedback[0].rating).toBe(1);
  });

  it('not found for someone else\'s reply', async () => {
    const other = { ...reply, conversation: { userId: 'u-2', tenantId: 't-1' } };
    const { svc } = setup({ messages: [other] });
    await expect(svc.submitFeedback(USER, { messageId: 'm-1', rating: 1 })).rejects.toBeInstanceOf(NotFoundException);
  });
});
