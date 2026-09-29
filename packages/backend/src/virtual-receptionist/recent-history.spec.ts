import { recentHistory, HISTORY_WINDOW } from "./recent-history";
import { ConversationMemoryRepository } from "./repositories/conversation-memory.repository";

/**
 * A real chat: at 20 messages the conversation was marked "handoff", the
 * next message (the client's phone number) opened a new conversation, and the
 * receptionist greeted them from scratch. Now long conversations keep going,
 * and what the model sees per turn is capped instead.
 */

const msgs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 === 0 ? "user" : "assistant", content: `m${i}` }));

describe("recentHistory", () => {
  it("passes a short conversation through", () => {
    expect(recentHistory(msgs(10))).toHaveLength(10);
  });

  it("keeps only the last window of a long one, starting on a client message", () => {
    const out = recentHistory(msgs(45));
    expect(out.length).toBeLessThanOrEqual(HISTORY_WINDOW);
    expect(out[0].role).toBe("user");
    expect(out[out.length - 1].content).toBe("m44");
  });
});

describe("resuming a conversation marked for a human", () => {
  it("finds 'handoff' conversations as well as 'active' ones", async () => {
    const finds: any[] = [];
    const prisma: any = {
      tenant: { findFirst: async () => ({ id: "11111111-1111-4111-8111-111111111111" }) },
      chatConversation: { findFirst: async (args: any) => { finds.push(args); return null; } },
    };
    await new ConversationMemoryRepository(prisma).findActiveConversationByClientId(
      "visitor-1",
      "11111111-1111-4111-8111-111111111111",
    );
    expect(finds[0].where.status).toEqual({ in: ["active", "handoff"] });
  });
});
