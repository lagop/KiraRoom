import { BadRequestException, NotFoundException } from "@nestjs/common";
import { GiftCardsService } from "./gift-cards.service";

describe("GiftCardsService", () => {
  let service: GiftCardsService;
  let prisma: any;

  const tenantId = "tenant-1";
  const cardId = "card-1";

  let txStore: any;
  let txClient: any;

  beforeEach(() => {
    txStore = { cards: new Map() };

    txClient = {
      giftCard: {
        findFirst: jest.fn(async ({ where }: any) =>
          txStore.cards.get(where.id) ?? null,
        ),
        update: jest.fn(async ({ where, data }: any) => {
          const card = txStore.cards.get(where.id);
          const updated = { ...card, ...data };
          txStore.cards.set(where.id, updated);
          return updated;
        }),
      },
      giftCardTransaction: {
        create: jest.fn(async ({ data }: any) => ({ id: "tx-1", ...data })),
      },
    };

    prisma = {
      giftCard: {
        create: jest.fn(async ({ data }: any) => {
          const card = {
            id: cardId,
            currentBalance: data.initialAmount,
            isActive: true,
            expiresAt: data.expiresAt ?? null,
            ...data,
            transactions: data.transactions?.create
              ? [{ id: "tx-1", ...data.transactions.create }]
              : [],
          };
          txStore.cards.set(cardId, card);
          return card;
        }),
        findFirst: jest.fn(async ({ where }: any) => {
          if (where.id && where.tenantId) {
            const card = txStore.cards.get(where.id);
            return card && card.tenantId === where.tenantId ? card : null;
          }
          if (where.code && where.tenantId) {
            for (const c of txStore.cards.values()) {
              if (c.code === where.code && c.tenantId === where.tenantId) {
                return c;
              }
            }
          }
          return null;
        }),
        findMany: jest.fn(async () => {
          return Array.from(txStore.cards.values()).filter(
            (c: any) => c.tenantId === tenantId,
          );
        }),
        count: jest.fn(async () => txStore.cards.size),
        update: jest.fn(async ({ where, data }: any) => {
          const card = txStore.cards.get(where.id);
          const updated = { ...card, ...data };
          txStore.cards.set(where.id, updated);
          return updated;
        }),
      },
      $transaction: jest.fn(async (cb: any) =>
        typeof cb === "function" ? cb(txClient) : txClient,
      ),
    };

    service = new GiftCardsService(prisma);
  });

  it("creates a gift card and writes the ISSUED transaction", async () => {
    const card = await service.create(tenantId, { initialAmount: 5000 } as any);
    expect(card.initialAmount).toBe(5000);
    expect(card.currentBalance).toBe(5000);
    expect(prisma.giftCard.create).toHaveBeenCalled();
  });

  it("rejects redeem when balance is insufficient", async () => {
    await service.create(tenantId, { initialAmount: 1000 } as any);
    await expect(
      service.redeem(tenantId, { giftCardId: cardId, amount: 2000 } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("rejects redeem on a non-existent card", async () => {
    await expect(
      service.redeem(tenantId, { giftCardId: "ghost", amount: 100 } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it("decrements balance on partial redeem", async () => {
    await service.create(tenantId, { initialAmount: 5000 } as any);
    const updated = await service.redeem(tenantId, {
      giftCardId: cardId,
      amount: 1500,
    } as any);
    expect(updated.currentBalance).toBe(3500);
  });

  it("auto-deactivates when balance reaches zero", async () => {
    await service.create(tenantId, { initialAmount: 1000 } as any);
    const updated = await service.redeem(tenantId, {
      giftCardId: cardId,
      amount: 1000,
    } as any);
    expect(updated.currentBalance).toBe(0);
    expect(updated.isActive).toBe(false);
  });

  it("rejects redeem on expired card", async () => {
    await service.create(tenantId, {
      initialAmount: 5000,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    } as any);
    await expect(
      service.redeem(tenantId, { giftCardId: cardId, amount: 100 } as any),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it("prevents cross-tenant redemption", async () => {
    await service.create(tenantId, { initialAmount: 5000 } as any);
    // Cross-tenant: the in-transaction findFirst must return null because the
    // card's tenantId does not match the requesting tenant.
    txClient.giftCard.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.redeem("tenant-2", { giftCardId: cardId, amount: 100 } as any),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});
