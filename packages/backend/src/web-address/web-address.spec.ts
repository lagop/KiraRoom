import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import { redirectExpiry, webAddressShapeProblem } from "./web-address-rules";
import { redirectedTenantId, WebAddressService, WEB_ADDRESS_ALREADY_CHANGED } from "./web-address.service";
import { availableTenantSlug } from "../saas/saas.helpers";

/** D4: the web address chosen at signup and changed once; the old one redirects for 12 months. */
describe("web address rules", () => {
  it("accepts a plain address and says what is wrong with the rest", () => {
    expect(webAddressShapeProblem("peluqueria-lucia")).toBeNull();
    expect(webAddressShapeProblem("ab")).toBe("too_short");
    expect(webAddressShapeProblem("a".repeat(64))).toBe("too_long");
    expect(webAddressShapeProblem("peluquería lucía")).toBe("format");
    expect(webAddressShapeProblem("-lucia")).toBe("format");
    expect(webAddressShapeProblem("lucia--centro")).toBe("format");
    expect(webAddressShapeProblem("app")).toBe("reserved");
    expect(webAddressShapeProblem("00000000-0000-4000-8000-000000000000")).toBe("reserved");
    expect(webAddressShapeProblem("lucia-kiraroom")).toBe("platform_word");
    expect(webAddressShapeProblem("soporte-lucia")).toBe("platform_word");
  });

  it("an old address redirects for 12 months", () => {
    expect(redirectExpiry(new Date("2026-11-04T10:00:00Z")).toISOString()).toBe("2027-11-04T10:00:00.000Z");
  });
});

function makePrisma(opts: {
  tenants?: Array<{ id: string; slug: string; slugChangedAt?: Date | null }>;
  redirects?: Array<{ oldSlug: string; tenantId: string; expiresAt: Date }>;
}) {
  const tenants = opts.tenants ?? [];
  const redirects = opts.redirects ?? [];
  const tx = {
    tenantSlugRedirect: {
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
      create: jest.fn().mockResolvedValue({}),
    },
    tenant: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
  };
  const prisma = {
    tenant: {
      findUnique: jest.fn(async ({ where }: { where: { slug?: string; id?: string } }) => {
        const t = tenants.find((x) => (where.slug !== undefined ? x.slug === where.slug : x.id === where.id));
        return t ? { slugChangedAt: null, ...t } : null;
      }),
    },
    tenantSlugRedirect: {
      findFirst: jest.fn(async ({ where }: { where: { oldSlug: string; expiresAt: { gt: Date } } }) =>
        redirects.find((r) => r.oldSlug === where.oldSlug && r.expiresAt > where.expiresAt.gt) ?? null,
      ),
    },
    $transaction: jest.fn(async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  return { prisma, tx };
}

describe("WebAddressService", () => {
  const future = new Date(Date.now() + 30 * 86_400_000);
  const past = new Date(Date.now() - 86_400_000);
  const owner = { id: "u1", role: "owner" };

  function service(p: ReturnType<typeof makePrisma>) {
    const audit = { record: jest.fn().mockResolvedValue({ id: "a1" }) };
    return { svc: new WebAddressService(p.prisma as never, audit as never), audit };
  }

  it("an address is taken by a salon, or while it still redirects; free once the redirect expired", async () => {
    const p = makePrisma({
      tenants: [{ id: "t2", slug: "salon-lucia" }],
      redirects: [
        { oldSlug: "lucia-centro", tenantId: "t2", expiresAt: future },
        { oldSlug: "lucia-viejo", tenantId: "t2", expiresAt: past },
      ],
    });
    const { svc } = service(p);
    expect((await svc.availability("Salon-Lucia ")).problem).toBe("taken");
    expect((await svc.availability("lucia-centro")).problem).toBe("taken");
    expect(await svc.availability("lucia-viejo")).toEqual({ slug: "lucia-viejo", available: true, problem: null, message: null });
    expect((await svc.availability("salon-lucia", "t2")).available).toBe(true);
  });

  it("changes once: the old address redirects for 12 months, and an audit row says so", async () => {
    const p = makePrisma({ tenants: [{ id: "t1", slug: "salon-ana" }] });
    const { svc, audit } = service(p);
    const now = new Date("2026-11-04T10:00:00Z");
    const out = await svc.change("t1", owner, "ana-madrid", now);
    expect(out).toEqual({ slug: "ana-madrid", previous: "salon-ana", redirectsUntil: new Date("2027-11-04T10:00:00Z") });
    expect(p.tx.tenant.updateMany).toHaveBeenCalledWith({
      where: { id: "t1", slugChangedAt: null },
      data: { slug: "ana-madrid", slugChangedAt: now },
    });
    expect(p.tx.tenantSlugRedirect.create).toHaveBeenCalledWith({
      data: { oldSlug: "salon-ana", tenantId: "t1", expiresAt: new Date("2027-11-04T10:00:00Z") },
    });
    // An expired row holding the new address is cleared first.
    expect(p.tx.tenantSlugRedirect.deleteMany).toHaveBeenCalledWith({ where: { oldSlug: "ana-madrid", expiresAt: { lte: now } } });
    expect(audit.record).toHaveBeenCalledWith("tenant.web_address_changed", expect.objectContaining({ tenantId: "t1" }), p.tx);
  });

  it("refuses a second change, a taken address, the team and support sessions", async () => {
    const changed = makePrisma({ tenants: [{ id: "t1", slug: "ana-madrid", slugChangedAt: new Date() }] });
    await expect(service(changed).svc.change("t1", owner, "ana-sol")).rejects.toThrow(WEB_ADDRESS_ALREADY_CHANGED);

    const taken = makePrisma({ tenants: [{ id: "t1", slug: "salon-ana" }, { id: "t2", slug: "ana-sol" }] });
    await expect(service(taken).svc.change("t1", owner, "ana-sol")).rejects.toBeInstanceOf(BadRequestException);

    const p = makePrisma({ tenants: [{ id: "t1", slug: "salon-ana" }] });
    await expect(service(p).svc.change("t1", { id: "u2", role: "admin" }, "ana-sol")).rejects.toBeInstanceOf(ForbiddenException);
    await expect(service(p).svc.change("t1", { ...owner, impersonatedBy: "s1" } as never, "ana-sol")).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it("losing the address to another salon at the same moment is a 409", async () => {
    const p = makePrisma({ tenants: [{ id: "t1", slug: "salon-ana" }] });
    p.tx.tenant.updateMany.mockRejectedValue(Object.assign(new Error("unique"), { code: "P2002" }));
    await expect(service(p).svc.change("t1", owner, "ana-sol")).rejects.toBeInstanceOf(ConflictException);
  });

  it("the resolvers find the salon by an old address until it expires", async () => {
    const p = makePrisma({ redirects: [{ oldSlug: "salon-ana", tenantId: "t1", expiresAt: future }] });
    expect(await redirectedTenantId(p.prisma, "salon-ana")).toBe("t1");
    expect(await redirectedTenantId(p.prisma, "salon-ana", new Date(future.getTime() + 1000))).toBeNull();
    expect(await redirectedTenantId(p.prisma, "otro")).toBeNull();
  });

  it("signup's made-up address skips one that still redirects", async () => {
    const p = makePrisma({ redirects: [{ oldSlug: "salon-ana", tenantId: "t1", expiresAt: future }] });
    await expect(availableTenantSlug(p.prisma, "Salón Ana")).resolves.toBe("salon-ana-2");
  });
});
