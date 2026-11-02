/**
 * Two salons may share a name: a signup with a name that is taken gets the
 * next free address instead of "Salon name already exists".
 */
import { ConflictException } from "@nestjs/common";
import { AuthService } from "./auth.service";
import { availableTenantSlug, tenantSlugCandidate, TENANT_SLUG_UNAVAILABLE } from "../saas/saas.helpers";

function p2002(target: string[]) {
  return Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target } });
}

function buildAuth(taken: string[], opts: { failCreate?: (slug: string) => Error | null } = {}) {
  const slugs = new Set(taken);
  const created: any[] = [];
  const prisma: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({ id: "u1", email: data.email, role: data.role })),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    tenant: {
      findUnique: jest.fn(async ({ where }: any) => (slugs.has(where.slug) ? { id: `t-${where.slug}` } : null)),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => {
        const err = opts.failCreate?.(data.slug);
        if (err) throw err;
        created.push(data);
        return { id: "t1" };
      }),
    },
    $transaction: jest.fn(async (fn: any) => fn(prisma)),
  };
  const auth = new AuthService(
    prisma,
    { sign: jest.fn().mockReturnValue("signed-jwt"), verify: jest.fn() } as any,
    { record: jest.fn() } as any,
    { record: jest.fn(), recordOnce: jest.fn().mockResolvedValue(undefined) } as any,
    { sendWelcome: jest.fn().mockResolvedValue({ success: true }) } as any,
    { start: jest.fn(async () => ({ sid: "sid-1", jti: "jti-1" })), rotate: jest.fn() } as any,
    {} as any,
  );
  (auth as any).sendActivationEmail = jest.fn().mockResolvedValue(undefined);
  return { auth, created, prisma };
}

const form = {
  email: "duena@salon-ficticio.test",
  password: "contraseña-de-prueba",
  salonName: "Peluquería Lucía",
  phone: "+34 600 000 000",
  ownerName: "Ana Prueba",
  acceptTerms: true,
};

describe("signup with a salon name that is taken", () => {
  it("a new name keeps its plain address", async () => {
    const { auth, created } = buildAuth([]);
    await auth.register(form as any);
    expect(created[0]).toMatchObject({ name: "Peluquería Lucía", slug: "peluqueria-lucia" });
  });

  it("a repeated name is accepted and gets the next free address", async () => {
    const { auth, created } = buildAuth(["peluqueria-lucia", "peluqueria-lucia-2"]);
    await auth.register(form as any);
    expect(created[0]).toMatchObject({ name: "Peluquería Lucía", slug: "peluqueria-lucia-3" });
  });

  it("a signup that loses the race for an address takes the next one", async () => {
    const { auth, created } = buildAuth(["peluqueria-lucia"], {
      failCreate: (slug) => (slug === "peluqueria-lucia-2" ? p2002(["slug"]) : null),
    });
    await auth.register(form as any);
    expect(created[0].slug).toBe("peluqueria-lucia-3");
  });

  it("if every try loses, the error is in Spanish", async () => {
    const { auth } = buildAuth([], { failCreate: () => p2002(["slug"]) });
    const err = await auth.register(form as any).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe(TENANT_SLUG_UNAVAILABLE);
    expect(err.message).not.toMatch(/already exists/i);
  });

  it("an email registered a moment ago is still an email clash, not a retry", async () => {
    const { auth, prisma } = buildAuth([], { failCreate: () => p2002(["email"]) });
    const err = await auth.register(form as any).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toBe("Email already registered");
    expect(prisma.tenant.create).toHaveBeenCalledTimes(1);
  });

  it("a name the platform keeps for itself gets a numbered address", async () => {
    const { auth, created } = buildAuth([]);
    await auth.register({ ...form, salonName: "App" } as any);
    expect(created[0]).toMatchObject({ name: "App", slug: "app-2" });
  });
});

describe("availableTenantSlug", () => {
  const prismaWith = (taken: string[]) => ({
    tenant: { findUnique: async ({ where }: any) => (taken.includes(where.slug) ? { id: "x" } : null) },
  });

  it("a name with no letters or digits still gets an address", async () => {
    expect(await availableTenantSlug(prismaWith([]), "¡¡!!")).toBe("salon");
  });

  it("a name shaped like an id never becomes a slug", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect(await availableTenantSlug(prismaWith([]), id)).toBe(`${id}-2`);
  });

  it("after the numbered addresses it falls back to a short random suffix", async () => {
    const taken = Array.from({ length: 20 }, (_, i) => tenantSlugCandidate("lucia", i + 1));
    expect(await availableTenantSlug(prismaWith(taken), "Lucía")).toMatch(/^lucia-[0-9a-f]{6}$/);
  });

  it("a numbered address of a long name stays a valid subdomain (63 chars)", () => {
    const base = "a".repeat(63);
    const slug = tenantSlugCandidate(base, 12);
    expect(slug.length).toBeLessThanOrEqual(63);
    expect(slug.endsWith("-12")).toBe(true);
  });
});
