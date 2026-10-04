import { NotFoundException } from "@nestjs/common";
import { ConversationMemoryRepository } from "./conversation-memory.repository";

/**
 * Which salon a receptionist conversation belongs to.
 *
 * The public chat endpoint takes the salon from the request. The repository
 * used to fall back, when it did not recognise it, to a salon whose name
 * merely contained the text, then to the first salon in the database, and
 * with none it created a sample "Kira Room" salon. So a wrong or empty salon
 * put a visitor in another salon's receptionist: its prices, bookings in its
 * agenda, its AI allowance spent. Only the salon's id or exact slug count now.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";

function setup() {
  const created: any[] = [];
  const prisma: any = {
    tenant: {
      findUnique: jest.fn(async ({ where }: any) => (where.id === TENANT ? { id: TENANT } : null)),
      findFirst: jest.fn(async ({ where }: any) => (where.slug === "salon-lucia" ? { id: TENANT } : null)),
      create: jest.fn(),
    },
    client: { findUnique: async () => null },
    chatConversation: {
      create: async ({ data }: any) => {
        created.push(data);
        return { id: "c1", ...data };
      },
    },
  };
  return { repo: new ConversationMemoryRepository(prisma), prisma, created };
}

describe("conversation salon", () => {
  it("takes the salon by id", async () => {
    const { repo, created } = setup();
    await repo.createConversation({ tenantId: TENANT, clientId: "v1" } as any);
    expect(created[0].tenantId).toBe(TENANT);
  });

  it("takes the salon by its exact slug", async () => {
    const { repo, prisma, created } = setup();
    await repo.createConversation({ tenantId: "Salon-Lucia", clientId: "v1" } as any);
    expect(created[0].tenantId).toBe(TENANT);
    expect(prisma.tenant.findFirst.mock.calls[0][0].where).toEqual({ slug: "salon-lucia" });
  });

  it.each([
    ["an unknown slug", "otro-salon"],
    ["an unknown id", "99999999-9999-4999-8999-999999999999"],
    ["nothing at all", ""],
    ["undefined", undefined],
  ])("refuses %s instead of using another salon", async (_label, tenantId) => {
    const { repo, prisma, created } = setup();
    await expect(repo.createConversation({ tenantId, clientId: "v1" } as any)).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(created).toHaveLength(0);
    // Never a sample salon, never a guess by name.
    expect(prisma.tenant.create).not.toHaveBeenCalled();
    for (const [args] of prisma.tenant.findFirst.mock.calls) {
      expect(JSON.stringify(args)).not.toContain("contains");
    }
  });
});
