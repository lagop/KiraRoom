import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { GiftCardsService, giftCardStatus, normalizeGiftCardCode } from "./gift-cards.service";

/**
 * An in-memory stand-in for the parts of Prisma the service uses. The
 * conditional `updateMany` evaluates its WHERE like Postgres would, so a
 * redemption that should not match does not.
 */
function fakePrisma(opts: { timezone?: string } = {}) {
  const cards = new Map<string, any>();
  const txs: any[] = [];
  const users = [{ id: "user-1", tenantId: "tenant-1", firstName: "Ana", lastName: "López" }];
  const tenants = new Map<string, any>([
    [
      "tenant-1",
      {
        id: "tenant-1",
        name: "Salón Lola",
        timezone: opts.timezone ?? "Europe/Madrid",
        phone: "600111222",
        street: "Calle Mayor 1",
        city: "Madrid",
        email: "hola@lola.es",
      },
    ],
    ["tenant-2", { id: "tenant-2", name: "Otro", timezone: "Europe/Madrid" }],
  ]);
  let seq = 0;

  const matches = (row: any, where: any): boolean => {
    if (!row) return false;
    for (const [k, v] of Object.entries<any>(where ?? {})) {
      if (k === "OR") {
        if (!v.some((w: any) => matches(row, w))) return false;
      } else if (v === null) {
        if (row[k] !== null && row[k] !== undefined) return false;
      } else if (typeof v === "object" && !(v instanceof Date)) {
        if ("gte" in v && !(row[k] !== null && row[k] >= v.gte)) return false;
        if ("gt" in v && !(row[k] !== null && row[k] > v.gt)) return false;
        if ("in" in v && !v.in.includes(row[k])) return false;
      } else if (row[k] !== v) return false;
    }
    return true;
  };

  const apply = (card: any, data: any) => {
    for (const [k, v] of Object.entries<any>(data)) {
      if (v === undefined) continue;
      if (v && typeof v === "object" && "decrement" in v) card[k] -= v.decrement;
      else if (v && typeof v === "object" && "increment" in v) card[k] += v.increment;
      else card[k] = v;
    }
    card.updatedAt = new Date();
    return card;
  };

  const db: any = {
    cards,
    txs,
    tenant: {
      findUnique: jest.fn(async ({ where }: any) => tenants.get(where.id) ?? null),
    },
    user: {
      findMany: jest.fn(async ({ where }: any) =>
        users.filter((u) => where.id.in.includes(u.id) && u.tenantId === where.tenantId),
      ),
    },
    giftCard: {
      create: jest.fn(async ({ data }: any) => {
        const card = {
          id: `card-${++seq}`,
          createdAt: new Date(),
          updatedAt: new Date(),
          isActive: true,
          purchasedById: null,
          recipientId: null,
          recipientEmail: null,
          recipientName: null,
          message: null,
          ...data,
        };
        cards.set(card.id, card);
        return { ...card };
      }),
      findFirst: jest.fn(async ({ where, include }: any) => {
        const card = [...cards.values()].find((c) => matches(c, where));
        if (!card) return null;
        const out: any = { ...card };
        if (include?.transactions) {
          out.transactions = txs.filter((t) => t.giftCardId === card.id).reverse();
        }
        if (include?.tenant) out.tenant = tenants.get(card.tenantId);
        return out;
      }),
      findMany: jest.fn(async ({ where }: any) =>
        [...cards.values()].filter((c) => matches(c, where)).map((c) => ({ ...c })),
      ),
      count: jest.fn(
        async ({ where }: any) => [...cards.values()].filter((c) => matches(c, where)).length,
      ),
      update: jest.fn(async ({ where, data }: any) => ({ ...apply(cards.get(where.id), data) })),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const hit = [...cards.values()].filter((c) => matches(c, where));
        hit.forEach((c) => apply(c, data));
        return { count: hit.length };
      }),
    },
    giftCardTransaction: {
      create: jest.fn(async ({ data }: any) => {
        const row = { id: `tx-${++seq}`, createdAt: new Date(), ...data };
        txs.push(row);
        return row;
      }),
      groupBy: jest.fn(async ({ where }: any) => {
        const rows = txs.filter((t) => matches(t, where));
        const by = new Map<string, number>();
        rows.forEach((t) => by.set(t.type, (by.get(t.type) ?? 0) + t.amount));
        return [...by.entries()].map(([type, amount]) => ({ type, _sum: { amount } }));
      }),
    },
    $queryRaw: jest.fn(async (_strings: TemplateStringsArray, id: string, tenantId: string) => {
      const c = cards.get(id);
      return c && c.tenantId === tenantId ? [{ id }] : [];
    }),
  };
  db.$transaction = jest.fn(async (cb: any) => cb(db));
  return db;
}

function fakeEmail(result: any = { success: true, id: "em-1" }) {
  return { sendEmail: jest.fn(async (_opts: any) => result) };
}

const tenantId = "tenant-1";
const DAY = 86_400_000;

/** "YYYY-MM-DD" for today + n days in Madrid. */
function madridDay(offsetDays = 0): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Madrid" }).format(
    new Date(Date.now() + offsetDays * DAY),
  );
}

describe("GiftCardsService", () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let email: ReturnType<typeof fakeEmail>;
  let service: GiftCardsService;

  beforeEach(() => {
    prisma = fakePrisma();
    email = fakeEmail();
    service = new GiftCardsService(prisma, email as any);
  });

  const newCard = (over: any = {}) =>
    service.create(tenantId, { initialAmount: 5000, ...over } as any, "user-1");

  describe("create", () => {
    it("issues the card with a Spanish 'created' movement, its balance and who issued it", async () => {
      const card = await newCard();
      expect(card.currentBalance).toBe(5000);
      expect(card.status).toBe("active");
      expect(prisma.txs).toEqual([
        expect.objectContaining({
          type: "created",
          amount: 5000,
          balanceAfter: 5000,
          createdById: "user-1",
          note: "Tarjeta regalo emitida",
        }),
      ]);
    });

    it("defaults to two years of validity, ending at the end of that day in Madrid", async () => {
      const card = await newCard();
      const today = madridDay();
      const year = Number(today.slice(0, 4)) + 2;
      // 29 Feb rolls over to 1 Mar.
      expect([`${year}${today.slice(4)}`, `${year}-03-01`]).toContain(card.expiresOn);
      const madrid = card.expiresAt!.toLocaleString("en-GB", {
        timeZone: "Europe/Madrid",
        hour12: false,
      });
      expect(madrid).toMatch(/23:59:59$/);
    });

    it("stores a picked day as the end of that day in the salon, so the last day works", async () => {
      const card = await newCard({ expiresAt: "2099-12-31" });
      // 23:59:59.999 in Madrid (CET, UTC+1).
      expect(card.expiresAt!.toISOString()).toBe("2099-12-31T22:59:59.999Z");
      expect(card.expiresOn).toBe("2099-12-31");
    });

    it("uses the salon's own timezone (Canarias)", async () => {
      prisma = fakePrisma({ timezone: "Atlantic/Canary" });
      service = new GiftCardsService(prisma, email as any);
      const card = await newCard({ expiresAt: "2099-07-31" });
      // WEST = UTC+1 in summer.
      expect(card.expiresAt!.toISOString()).toBe("2099-07-31T22:59:59.999Z");
      expect(card.expiresOn).toBe("2099-07-31");
    });

    it("allows today and refuses a day in the past", async () => {
      await expect(newCard({ expiresAt: madridDay() })).resolves.toBeTruthy();
      await expect(newCard({ expiresAt: madridDay(-1) })).rejects.toThrow(
        "La fecha de caducidad no puede ser anterior a hoy",
      );
    });

    it("null means the card never expires", async () => {
      const card = await newCard({ expiresAt: null });
      expect(card.expiresAt).toBeNull();
      expect(card.expiresOn).toBeNull();
    });

    it("emails the card to the recipient (Spanish: salon, amount, code, expiry, how to use)", async () => {
      const card = await newCard({
        recipientEmail: "ana@example.com",
        recipientName: "Ana",
        expiresAt: "2099-12-31",
      });
      expect(card.emailSent).toBe(true);
      expect(email.sendEmail).toHaveBeenCalledTimes(1);
      const sent = email.sendEmail.mock.calls[0][0];
      expect(sent.to).toBe("ana@example.com");
      expect(sent.subject).toBe("Tienes una tarjeta regalo de 50,00 € en Salón Lola");
      expect(sent.replyTo).toBe("hola@lola.es");
      expect(sent.text).toContain("Hola Ana,");
      expect(sent.text).toContain(card.code.replace(/(.{4})(?=.)/g, "$1 "));
      expect(sent.text).toContain("Válida hasta el 31 de diciembre de 2099 (incluido)");
      expect(sent.text).toContain("Cómo usarla");
      expect(sent.html).toContain("Salón Lola");
    });

    it("does not email when the box is unticked or there is no recipient email", async () => {
      const a = await newCard({ recipientEmail: "ana@example.com", sendEmail: false });
      const b = await newCard();
      expect(email.sendEmail).not.toHaveBeenCalled();
      expect(a.emailSent).toBeNull();
      expect(b.emailSent).toBeNull();
    });

    it("keeps the card when the email fails, and says so", async () => {
      email.sendEmail.mockRejectedValueOnce(new Error("boom"));
      const card = await newCard({ recipientEmail: "ana@example.com" });
      expect(card.emailSent).toBe(false);
      expect(prisma.cards.size).toBe(1);
    });
  });

  describe("redeemInTx", () => {
    it("takes the amount and records the movement with the balance left and the user", async () => {
      const card = await newCard();
      const { card: after, transaction } = await service.redeemInTx(prisma, {
        tenantId,
        giftCardId: card.id,
        amountCents: 1500,
        paymentId: "pay-1",
        userId: "user-1",
      });
      expect(after.currentBalance).toBe(3500);
      expect(transaction).toEqual(
        expect.objectContaining({
          type: "applied",
          amount: 1500,
          balanceAfter: 3500,
          paymentId: "pay-1",
          createdById: "user-1",
        }),
      );
    });

    it("finds the card by the code as typed at the till", async () => {
      const card = await newCard();
      const typed = ` ${card.code.slice(0, 4).toLowerCase()}-${card.code.slice(4)} `;
      const { card: after } = await service.redeemInTx(prisma, {
        tenantId,
        code: typed,
        amountCents: 100,
      });
      expect(after.currentBalance).toBe(4900);
    });

    it("uses one conditional update (balance, active, not expired), never a read-then-write", async () => {
      const card = await newCard();
      await service.redeemInTx(prisma, { tenantId, giftCardId: card.id, amountCents: 100 });
      const call = prisma.giftCard.updateMany.mock.calls[0][0];
      expect(call.where).toEqual({
        id: card.id,
        tenantId,
        isActive: true,
        currentBalance: { gte: 100 },
        OR: [{ expiresAt: null }, { expiresAt: { gte: expect.any(Date) } }],
      });
      expect(call.data).toEqual({ currentBalance: { decrement: 100 } });
      expect(prisma.giftCard.update).not.toHaveBeenCalled();
    });

    it("spending it all leaves it 'Agotada' and refuses the next redemption", async () => {
      const card = await newCard({ initialAmount: 1000 });
      const { card: after } = await service.redeemInTx(prisma, {
        tenantId,
        giftCardId: card.id,
        amountCents: 1000,
      });
      expect(after.currentBalance).toBe(0);
      expect(giftCardStatus(after)).toBe("spent");
      await expect(
        service.redeemInTx(prisma, { tenantId, giftCardId: card.id, amountCents: 1 }),
      ).rejects.toThrow("La tarjeta regalo no tiene saldo");
    });

    it("says why it refuses, in Spanish", async () => {
      const card = await newCard({ initialAmount: 1000 });
      await expect(
        service.redeemInTx(prisma, { tenantId, giftCardId: card.id, amountCents: 2000 }),
      ).rejects.toThrow("Saldo insuficiente en la tarjeta regalo: quedan 10,00 €");

      prisma.cards.get(card.id).expiresAt = new Date(Date.now() - 1000);
      await expect(
        service.redeemInTx(prisma, { tenantId, giftCardId: card.id, amountCents: 100 }),
      ).rejects.toThrow("La tarjeta regalo ha caducado");

      prisma.cards.get(card.id).expiresAt = null;
      prisma.cards.get(card.id).isActive = false;
      await expect(
        service.redeemInTx(prisma, { tenantId, giftCardId: card.id, amountCents: 100 }),
      ).rejects.toThrow("La tarjeta regalo no está activa");

      await expect(
        service.redeemInTx(prisma, { tenantId, code: "NOPE", amountCents: 100 }),
      ).rejects.toThrow("Tarjeta regalo no encontrada");
      expect(prisma.txs.filter((t: any) => t.type === "applied")).toHaveLength(0);
      expect(prisma.cards.get(card.id).currentBalance).toBe(1000);
    });

    it("a card that could pay but lost the race is a 409 to retry", async () => {
      const card = await newCard();
      prisma.giftCard.updateMany.mockResolvedValueOnce({ count: 0 });
      await expect(
        service.redeemInTx(prisma, { tenantId, giftCardId: card.id, amountCents: 100 }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it("cannot redeem another salon's card", async () => {
      const card = await newCard();
      await expect(
        service.redeemInTx(prisma, { tenantId: "tenant-2", giftCardId: card.id, amountCents: 100 }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.cards.get(card.id).currentBalance).toBe(5000);
    });

    it("refuses amounts that are not whole positive cents", async () => {
      const card = await newCard();
      for (const amountCents of [0, -5, 1.5]) {
        await expect(
          service.redeemInTx(prisma, { tenantId, giftCardId: card.id, amountCents }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it("the panel's redeem goes through it and records who redeemed", async () => {
      const card = await newCard();
      const out = await service.redeem(
        tenantId,
        { giftCardId: card.id, amount: 700, note: "Corte" } as any,
        "user-1",
      );
      expect(out.currentBalance).toBe(4300);
      expect(out.status).toBe("active");
      expect(prisma.txs[prisma.txs.length - 1]).toEqual(
        expect.objectContaining({
          type: "applied",
          amount: 700,
          createdById: "user-1",
          note: "Corte",
          balanceAfter: 4300,
        }),
      );
    });
  });

  describe("refundToCard", () => {
    it("gives back what a payment took, writing a 'refunded' movement", async () => {
      const card = await newCard();
      await service.redeemInTx(prisma, {
        tenantId,
        giftCardId: card.id,
        amountCents: 3000,
        paymentId: "pay-1",
      });
      const { card: after, transaction } = await service.refundToCard(prisma, {
        tenantId,
        giftCardId: card.id,
        amountCents: 1000,
        paymentId: "pay-1",
        userId: "user-1",
      });
      expect(after.currentBalance).toBe(3000);
      expect(transaction).toEqual(
        expect.objectContaining({
          type: "refunded",
          amount: 1000,
          balanceAfter: 3000,
          paymentId: "pay-1",
          createdById: "user-1",
        }),
      );
      expect(prisma.$queryRaw).toHaveBeenCalled(); // row lock
    });

    it("never gives back more than the payment took, net of earlier refunds", async () => {
      const card = await newCard();
      await service.redeemInTx(prisma, {
        tenantId,
        giftCardId: card.id,
        amountCents: 3000,
        paymentId: "pay-1",
      });
      await service.refundToCard(prisma, {
        tenantId,
        giftCardId: card.id,
        amountCents: 2000,
        paymentId: "pay-1",
      });
      await expect(
        service.refundToCard(prisma, {
          tenantId,
          giftCardId: card.id,
          amountCents: 1500,
          paymentId: "pay-1",
        }),
      ).rejects.toThrow("Solo se pueden devolver 10,00 € a la tarjeta regalo por este pago");
      await expect(
        service.refundToCard(prisma, {
          tenantId,
          giftCardId: card.id,
          amountCents: 100,
          paymentId: "pay-other",
        }),
      ).rejects.toThrow("Este pago no tiene nada que devolver a la tarjeta regalo");
    });

    it("a card switched off only because it was spent comes back with the money", async () => {
      const card = await newCard({ initialAmount: 1000 });
      await service.redeemInTx(prisma, {
        tenantId,
        giftCardId: card.id,
        amountCents: 1000,
        paymentId: "pay-1",
      });
      prisma.cards.get(card.id).isActive = false; // cards used to switch themselves off at 0
      const { card: after } = await service.refundToCard(prisma, {
        tenantId,
        giftCardId: card.id,
        amountCents: 1000,
        paymentId: "pay-1",
      });
      expect(after.isActive).toBe(true);
      expect(giftCardStatus(after)).toBe("active");
    });

    it("refuses an expired card or one the salon switched off with money on it", async () => {
      const card = await newCard();
      await service.redeemInTx(prisma, {
        tenantId,
        giftCardId: card.id,
        amountCents: 1000,
        paymentId: "pay-1",
      });
      prisma.cards.get(card.id).isActive = false;
      await expect(
        service.refundToCard(prisma, {
          tenantId,
          giftCardId: card.id,
          amountCents: 100,
          paymentId: "pay-1",
        }),
      ).rejects.toThrow("no está activa");
      prisma.cards.get(card.id).isActive = true;
      prisma.cards.get(card.id).expiresAt = new Date(Date.now() - 1000);
      await expect(
        service.refundToCard(prisma, {
          tenantId,
          giftCardId: card.id,
          amountCents: 100,
          paymentId: "pay-1",
        }),
      ).rejects.toThrow("ha caducado");
    });

    it("cannot touch another salon's card", async () => {
      const card = await newCard();
      await expect(
        service.refundToCard(prisma, {
          tenantId: "tenant-2",
          giftCardId: card.id,
          amountCents: 100,
          paymentId: "p",
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe("sellInTx", () => {
    it("creates a card linked to the sale payment, with who sold it", async () => {
      const { card, transaction } = await service.sellInTx(prisma, {
        tenantId,
        amountCents: 3000,
        paymentId: "pay-sale",
        userId: "user-1",
        recipientName: "Ana",
        expiresOn: "2099-06-30",
      });
      expect(card).toEqual(
        expect.objectContaining({ initialAmount: 3000, currentBalance: 3000, tenantId }),
      );
      expect(card.expiresAt!.toISOString()).toBe("2099-06-30T21:59:59.999Z"); // CEST
      expect(transaction).toEqual(
        expect.objectContaining({
          type: "created",
          amount: 3000,
          balanceAfter: 3000,
          paymentId: "pay-sale",
          createdById: "user-1",
          note: "Tarjeta regalo vendida",
        }),
      );
      // The POS emails it once the sale has committed (sendCardEmail).
      expect(email.sendEmail).not.toHaveBeenCalled();
    });

    it("needs the payment it was sold with", async () => {
      await expect(
        service.sellInTx(prisma, { tenantId, amountCents: 3000, paymentId: "" }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it("sendCardEmail emails a sold card afterwards", async () => {
      const { card } = await service.sellInTx(prisma, {
        tenantId,
        amountCents: 3000,
        paymentId: "pay-sale",
        recipientEmail: "luis@example.com",
      });
      await expect(service.sendCardEmail(tenantId, card.id)).resolves.toEqual({ sent: true });
      expect(email.sendEmail.mock.calls[0][0].to).toBe("luis@example.com");
      await expect(service.sendCardEmail("tenant-2", card.id)).resolves.toEqual({
        sent: false,
        error: "no_recipient",
      });
    });
  });

  describe("update", () => {
    it("will not reactivate a spent card", async () => {
      const card = await newCard({ initialAmount: 1000 });
      await service.redeemInTx(prisma, { tenantId, giftCardId: card.id, amountCents: 1000 });
      prisma.cards.get(card.id).isActive = false;
      await expect(service.update(tenantId, card.id, { isActive: true })).rejects.toThrow(
        "No se puede reactivar una tarjeta regalo agotada",
      );
    });

    it("will not reactivate an expired card unless the same edit moves the date forward", async () => {
      const card = await newCard();
      Object.assign(prisma.cards.get(card.id), {
        isActive: false,
        expiresAt: new Date(Date.now() - DAY),
      });
      await expect(service.update(tenantId, card.id, { isActive: true })).rejects.toThrow(
        "No se puede reactivar una tarjeta regalo caducada",
      );
      const out = await service.update(tenantId, card.id, {
        isActive: true,
        expiresAt: madridDay(30),
      });
      expect(out.isActive).toBe(true);
      expect(out.status).toBe("active");
      expect(out.expiresOn).toBe(madridDay(30));
    });

    it("refuses a new expiry in the past and allows removing it", async () => {
      const card = await newCard();
      await expect(
        service.update(tenantId, card.id, { expiresAt: madridDay(-3) }),
      ).rejects.toThrow("anterior a hoy");
      const out = await service.update(tenantId, card.id, { expiresAt: null });
      expect(out.expiresAt).toBeNull();
    });

    it("is a Spanish 404 for another salon's card", async () => {
      const card = await newCard();
      await expect(service.update("tenant-2", card.id, { message: "x" })).rejects.toThrow(
        "Tarjeta regalo no encontrada",
      );
    });
  });

  describe("reads", () => {
    it("lists with the derived status (Caducada, Agotada)", async () => {
      const a = await newCard();
      const b = await newCard();
      const c = await newCard();
      prisma.cards.get(b.id).expiresAt = new Date(Date.now() - 1000);
      prisma.cards.get(c.id).currentBalance = 0;
      const list = await service.findAll(tenantId, { page: 1, limit: 20 });
      const byId = new Map(list.items.map((i: any) => [i.id, i.status]));
      expect(byId.get(a.id)).toBe("active");
      expect(byId.get(b.id)).toBe("expired");
      expect(byId.get(c.id)).toBe("spent");
    });

    it("clamps bad paging instead of failing", async () => {
      const out = await service.findAll(tenantId, { page: NaN, limit: 10_000 });
      expect(out.page).toBe(1);
      expect(out.limit).toBe(100);
    });

    it("the detail carries the movements with who made each", async () => {
      const card = await newCard();
      await service.redeemInTx(prisma, {
        tenantId,
        giftCardId: card.id,
        amountCents: 500,
        userId: "user-1",
      });
      const detail = await service.findOne(tenantId, card.id);
      expect(
        detail.transactions.map((t: any) => [t.type, t.balanceAfter, t.createdByName]),
      ).toEqual([
        ["applied", 4500, "Ana López"],
        ["created", 5000, "Ana López"],
      ]);
    });

    it("looks a code up however it was typed", async () => {
      const card = await newCard();
      const found = await service.lookupByCode(tenantId, card.code.toLowerCase());
      expect(found.id).toBe(card.id);
      await expect(service.lookupByCode("tenant-2", card.code)).rejects.toThrow(
        "Tarjeta regalo no encontrada",
      );
    });

    it("remove switches the card off and is idempotent", async () => {
      const card = await newCard();
      expect((await service.remove(tenantId, card.id)).status).toBe("inactive");
      expect((await service.remove(tenantId, card.id)).isActive).toBe(false);
    });
  });
});

describe("gift card helpers", () => {
  it("normalizes codes", () => {
    expect(normalizeGiftCardCode(" ab12-cd34 ef56 ")).toBe("AB12CD34EF56");
  });

  it("status: spent beats expired beats inactive", () => {
    const past = new Date(Date.now() - 1000);
    expect(giftCardStatus({ isActive: false, currentBalance: 0, expiresAt: past })).toBe("spent");
    expect(giftCardStatus({ isActive: false, currentBalance: 10, expiresAt: past })).toBe(
      "expired",
    );
    expect(giftCardStatus({ isActive: false, currentBalance: 10, expiresAt: null })).toBe(
      "inactive",
    );
    expect(giftCardStatus({ isActive: true, currentBalance: 10, expiresAt: null })).toBe("active");
  });
});
