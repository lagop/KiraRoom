import { ConversationMemoryRepository, WEB_CHAT_SESSION_MINUTES } from "./conversation-memory.repository";

/**
 * A conversation's clientId is a FK to Client, so it is null for any visitor
 * who is not a client -- and looking them up by clientId never matched: every
 * message from an anonymous visitor opened a new conversation with no memory.
 * The visitor's key now lives in context.visitorKey.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";

function repo(clientExists = false) {
  const created: any[] = [];
  const finds: any[] = [];
  const prisma: any = {
    tenant: {
      findFirst: async () => ({ id: TENANT }),
      findUnique: async ({ where }: any) => (where.id === TENANT ? { id: TENANT } : null),
    },
    client: { findUnique: async () => (clientExists ? { id: CLIENT } : null) },
    chatConversation: {
      create: async ({ data }: any) => { created.push(data); return { id: "c1", ...data }; },
      findFirst: async (args: any) => { finds.push(args); return null; },
    },
  };
  return { repo: new ConversationMemoryRepository(prisma), created, finds };
}

describe("visitor conversations", () => {
  it("remembers a visitor's key when the client FK must stay null", async () => {
    const { repo: r, created } = repo();
    await r.createConversation({ tenantId: TENANT, clientId: "visitor-abc", context: { a: 1 } } as any);
    expect(created[0].clientId).toBeUndefined();
    expect(created[0].context).toEqual({ a: 1, visitorKey: "visitor-abc" });
  });

  it("does not store 'anonymous' as a key: every visitor sent it", async () => {
    const { repo: r, created } = repo();
    await r.createConversation({ tenantId: TENANT, clientId: "anonymous" } as any);
    expect(created[0].context).toEqual({});
  });

  it("finds a visitor's conversation by their key", async () => {
    const { repo: r, finds } = repo();
    await r.findActiveConversationByClientId("visitor-abc", TENANT);
    expect(finds[0].where.AND[0].OR).toEqual([{ context: { path: ["visitorKey"], equals: "visitor-abc" } }]);
    expect(finds[0].where.tenantId).toBe(TENANT);
  });

  it("finds a client's conversation by clientId or key", async () => {
    const { repo: r, finds } = repo();
    await r.findActiveConversationByClientId(CLIENT, TENANT);
    expect(finds[0].where.AND[0].OR).toEqual([
      { clientId: CLIENT },
      { context: { path: ["visitorKey"], equals: CLIENT } },
    ]);
  });

  it("never resumes a conversation for 'anonymous'", async () => {
    const { repo: r, finds } = repo();
    expect(await r.findActiveConversationByClientId("anonymous", TENANT)).toBeNull();
    expect(finds).toHaveLength(0);
  });

  it("resolves a salon slug to its id", async () => {
    const { repo: r, finds } = repo();
    await r.findActiveConversationByClientId("visitor-abc", "salon-ana");
    expect(finds[0].where.tenantId).toBe(TENANT);
  });

  it("the web chat starts over after 30 idle minutes, the other channels after an hour (D19)", async () => {
    expect(WEB_CHAT_SESSION_MINUTES).toBe(30);
    const { repo: r, finds } = repo();
    const before = Date.now();
    await r.findActiveConversationByClientId("visitor-abc", TENANT, { channel: "web" });
    await r.findActiveConversationByClientId("whatsapp-34600111222", TENANT, { channel: "whatsapp" });
    const since = (i: number) => finds[i].where.AND[1].OR[0].lastActivityAt.gte.getTime();
    expect(Math.round((before - since(0)) / 60_000)).toBe(30);
    expect(Math.round((before - since(1)) / 60_000)).toBe(60);
  });

  it("a paused conversation stays hers however long she waits", async () => {
    const { repo: r, finds } = repo();
    await r.findActiveConversationByClientId("visitor-abc", TENANT, { channel: "web" });
    expect(finds[0].where.AND[1].OR[1]).toEqual({ assistantPausedAt: { not: null } });
  });

  it("Nueva conversación closes her open conversations, except a paused one", async () => {
    const updates: any[] = [];
    const prisma: any = { chatConversation: { updateMany: async (a: any) => { updates.push(a); return { count: 1 }; } } };
    await new ConversationMemoryRepository(prisma).closeActiveConversations("visitor-abc", TENANT);
    expect(updates[0]).toEqual({
      where: {
        tenantId: TENANT,
        status: { in: ["active", "handoff"] },
        assistantPausedAt: null,
        OR: [{ context: { path: ["visitorKey"], equals: "visitor-abc" } }],
      },
      data: { status: "completed" },
    });
  });
});
