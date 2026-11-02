/**
 * The receptionist loads exactly the salon it was asked for: by its id, or
 * else by its slug. It used to also take any salon whose name or slug merely
 * contained the value, so a chat could answer with another salon's services,
 * prices, team and hours.
 */
import { ConfigService } from "@nestjs/config";
import { LLMService } from "./llm.service";

type Row = { id: string; name: string; slug: string; createdAt: Date };

const LUCIA: Row = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Peluquería Lucía",
  slug: "peluqueria-lucia",
  createdAt: new Date("2026-01-01"),
};
const LUCIA_CENTRO: Row = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Peluquería Lucía Centro",
  slug: "peluqueria-lucia-centro",
  createdAt: new Date("2026-02-01"),
};

/** A where clause evaluated the way Postgres would, `contains` included. */
function matches(row: Row, where: any): boolean {
  if (where.OR) return where.OR.some((w: any) => matches(row, w));
  return Object.entries(where).every(([key, cond]: [string, any]) => {
    const value = String((row as any)[key]);
    if (typeof cond === "string") return value === cond;
    const insensitive = cond.mode === "insensitive";
    const norm = (s: string) => (insensitive ? s.toLowerCase() : s);
    if (cond.equals !== undefined) return norm(value) === norm(cond.equals);
    if (cond.contains !== undefined) return norm(value).includes(norm(cond.contains));
    throw new Error(`unexpected condition on ${key}: ${JSON.stringify(cond)}`);
  });
}

function build(rows: Row[]) {
  const findFirst = jest.fn(async ({ where }: any) => {
    const row = rows.find((r) => matches(r, where));
    return row ? { ...row, language: "es", services: [], professionals: [], customDomain: null } : null;
  });
  const prisma = { tenant: { findFirst }, timeOff: { findMany: async () => [] } };
  const configService = { get: (): undefined => undefined } as unknown as ConfigService;
  const faqs = { getFAQs: async () => [] };
  const flags = { isFeatureUnlocked: async () => false };
  const stub = {} as any;
  const service = new LLMService(stub, configService, prisma as any, faqs as any, flags as any, stub, stub);
  const contextFor = (salonId: string) => (service as any).getSalonContext(salonId);
  return { contextFor, findFirst };
}

describe("the receptionist's salon lookup", () => {
  it("finds the salon by its id", async () => {
    const { contextFor } = build([LUCIA, LUCIA_CENTRO]);
    expect((await contextFor(LUCIA_CENTRO.id))?.slug).toBe("peluqueria-lucia-centro");
  });

  it("finds the salon by its exact slug, in any case", async () => {
    const { contextFor } = build([LUCIA, LUCIA_CENTRO]);
    expect((await contextFor("peluqueria-lucia"))?.name).toBe("Peluquería Lucía");
    expect((await contextFor("Peluqueria-Lucia-Centro"))?.name).toBe("Peluquería Lucía Centro");
  });

  it("a part of a name is no longer a salon", async () => {
    const { contextFor } = build([LUCIA, LUCIA_CENTRO]);
    expect(await contextFor("Lucía")).toBeNull();
    expect(await contextFor("Centro")).toBeNull();
  });

  it("a part of a slug, or the slug without hyphens, is no longer a salon", async () => {
    const { contextFor } = build([LUCIA, LUCIA_CENTRO]);
    expect(await contextFor("lucia")).toBeNull();
    expect(await contextFor("peluquerialucia")).toBeNull();
    expect(await contextFor("PeluqueriaLucia")).toBeNull();
  });

  it("never asks the database for a partial match", async () => {
    const { contextFor, findFirst } = build([LUCIA]);
    await contextFor("lucia");
    const wheres = JSON.stringify(findFirst.mock.calls.map(([args]) => args.where));
    expect(wheres).not.toMatch(/contains|"name"/);
  });

  it("the id wins over a slug that looks like it", async () => {
    const impostor: Row = {
      id: "33333333-3333-4333-8333-333333333333",
      name: "Otro salón",
      slug: LUCIA.id,
      createdAt: new Date("2025-01-01"),
    };
    // The impostor comes first, so a single OR lookup could return it.
    const { contextFor } = build([impostor, LUCIA]);
    expect((await contextFor(LUCIA.id))?.name).toBe("Peluquería Lucía");
  });
});
