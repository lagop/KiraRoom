import { phoneKey } from "../common/phone";
import { PosService } from "./pos.service";

/**
 * The client typed at the till (no client picked): found again by her phone
 * however it was stored, or by her email in any case; created otherwise,
 * stored like every other client. The phone used to be compared as typed
 * ("600 111 222" missed "+34600111222" and made a second client) and an
 * email already on file failed the sale with a unique-constraint error.
 */
function build(existing: Array<{ id: string; email?: string | null; phone?: string | null }> = []) {
  const rows = existing.map((c) => ({ tenantId: "t1", createdAt: new Date(), ...c }));
  const created: any[] = [];
  const prisma: any = {
    tenant: { findUnique: async () => ({ country: "ES" }) },
    $queryRaw: jest.fn(async (_s: TemplateStringsArray, tenantId: string, key: string) =>
      rows.filter((c) => c.tenantId === tenantId && phoneKey(c.phone) === key).slice(0, 1).map((c) => ({ id: c.id })),
    ),
    client: {
      findFirst: jest.fn(async ({ where }: any) => {
        const wanted = where.email?.equals?.toLowerCase();
        return rows.find((c) => c.tenantId === where.tenantId && c.email?.toLowerCase() === wanted) ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        if (data.email && rows.some((c) => c.email === data.email)) {
          throw Object.assign(new Error("Unique constraint"), { code: "P2002" });
        }
        created.push(data);
        return { id: "new" };
      }),
    },
  };
  const service = new PosService(prisma, {} as any);
  const walkIn = (info: any): Promise<string> => (service as any).walkInClient("t1", info);
  return { walkIn, prisma, created, rows };
}

describe("POS walk-in client", () => {
  it("finds her by the last nine digits of her phone, however it was typed", async () => {
    const { walkIn, prisma } = build([{ id: "ana", phone: "+34600111222" }]);
    expect(await walkIn({ firstName: "Ana", phone: "600 111 222" })).toBe("ana");
    expect(await walkIn({ firstName: "Ana", phone: "0034 600-111-222" })).toBe("ana");
    expect(prisma.client.create).not.toHaveBeenCalled();
  });

  it("finds her by her email in any case when the phone does not match", async () => {
    const { walkIn, prisma } = build([{ id: "eva", email: "eva@mail.es", phone: null }]);
    expect(await walkIn({ firstName: "Eva", email: "EVA@Mail.es", phone: "699 888 777" })).toBe("eva");
    expect(prisma.client.create).not.toHaveBeenCalled();
  });

  it("creates a new client with the email in lower case and the phone in international form", async () => {
    const { walkIn, created } = build();
    expect(await walkIn({ firstName: " Luz ", lastName: "Gil", email: " Luz@Mail.ES", phone: "611 222 333" })).toBe("new");
    expect(created[0]).toMatchObject({
      tenantId: "t1",
      firstName: "Luz",
      lastName: "Gil",
      email: "luz@mail.es",
      phone: "+34611222333",
      status: "active",
    });
  });

  it("an email taken meanwhile is her: the sale goes to that record instead of failing", async () => {
    const { walkIn, prisma, rows } = build();
    // Not there at lookup time, there when inserting (another till, a booking).
    let lookups = 0;
    prisma.client.findFirst.mockImplementation(async ({ where }: any) => {
      lookups += 1;
      if (lookups === 1) return null;
      return rows.find((c) => c.email === where.email.equals) ?? null;
    });
    rows.push({ id: "raced", tenantId: "t1", createdAt: new Date(), email: "mar@mail.es", phone: null });
    expect(await walkIn({ firstName: "Mar", email: "mar@mail.es" })).toBe("raced");
  });
});
