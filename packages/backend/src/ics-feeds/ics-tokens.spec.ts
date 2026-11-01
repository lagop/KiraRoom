import { BadRequestException, NotFoundException } from "@nestjs/common";
import { IcsController, icsFeedVersion } from "./ics.controller";

/**
 * The calendar-feeds page handed out ?token=REEMPLAZAR_CON_TOKEN and pointed
 * at GET /ics/tokens as "coming soon". The endpoint now exists; its tokens
 * must be exactly what the public feeds accept.
 *
 * Tokens also never expired and could not be revoked. POST
 * /ics/tokens/rotate bumps Tenant.features.icsFeed.version; links signed for
 * an older version stop working, and a salon that never rotated (version 0)
 * keeps the links its calendars are already subscribed to.
 */

const SECRET = "ics-secret";

function build(features: any = {}, { professionalActive = true, userActive = true } = {}) {
  const tenant = { id: "t1", slug: "salon-ana", name: "Salón Ana", features };
  const raw: Array<{ sql: string; values: unknown[] }> = [];
  const prisma: any = {
    tenant: {
      findUnique: async ({ where }: any) =>
        where.id === "t1" || where.slug === "salon-ana" ? { ...tenant } : null,
    },
    professional: {
      findMany: async ({ where }: any) =>
        where.tenantId === "t1" ? [{ id: "pro-1", firstName: "Ana", lastName: "López" }] : [],
      findUnique: async ({ where }: any) =>
        where.id === "pro-1" ? { id: "pro-1", isActive: professionalActive, tenant: { ...tenant } } : null,
    },
    user: {
      findUnique: async ({ where }: any) =>
        where.id === "user-1" ? { id: "user-1", tenantId: "t1", isActive: userActive, professional: null, tenant: { ...tenant } } : null,
    },
    appointment: { findMany: async () => [] },
    // Stands in for the jsonb_set UPDATE: bumps the version like Postgres would.
    $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      raw.push({ sql: strings.join("?"), values });
      if (values[0] !== "t1") return [];
      tenant.features = {
        ...tenant.features,
        icsFeed: { version: icsFeedVersion(tenant.features) + 1, rotatedAt: "2026-10-31T10:00:00.000Z" },
      };
      return [{ id: "t1" }];
    },
  };
  const config: any = { get: (k: string) => (k === "ICS_TOKEN_SECRET" ? SECRET : undefined) };
  return { controller: new IcsController(prisma, config), raw, tenant };
}

function res() {
  const out: any = { statusCode: 200, headers: {} as Record<string, string> };
  out.status = (s: number) => ((out.statusCode = s), out);
  out.setHeader = (k: string, v: string) => (out.headers[k] = v);
  out.send = (b: string) => ((out.body = b), out);
  return out;
}

describe("GET /ics/tokens", () => {
  it("signs the caller's salon and professionals", async () => {
    const out = await build().controller.tokens({ user: { tenantId: "t1" } });

    expect(out.version).toBe(0);
    expect(out.rotatedAt).toBeNull();
    expect(out.salon).toEqual({
      slug: "salon-ana",
      token: IcsController.signToken("salon:salon-ana", SECRET),
    });
    expect(out.professionals).toEqual([
      { id: "pro-1", name: "Ana López", token: IcsController.signToken("professional:pro-1", SECRET) },
    ]);
  });

  it("issues tokens the feeds accept, and only those", () => {
    const controller = build().controller as any;
    const good = IcsController.signToken("salon:salon-ana", SECRET);

    expect(() => controller.verifyToken("salon:salon-ana", good)).not.toThrow();
    expect(() => controller.verifyToken("salon:salon-ana", "REEMPLAZAR_CON_TOKEN")).toThrow(BadRequestException);
    expect(() => controller.verifyToken("salon:other", good)).toThrow(BadRequestException);
  });
});

describe("ICS feed revocation", () => {
  // Signed before versions existed: what subscribed calendars hold today.
  const legacySalon = IcsController.signToken("salon:salon-ana", SECRET);
  const legacyPro = IcsController.signToken("professional:pro-1", SECRET);
  const legacyStaff = IcsController.signToken("staff:user-1", SECRET);

  it("version 0 signs exactly as before, so subscribed calendars keep working", async () => {
    const { controller } = build();

    expect(IcsController.signToken("salon:salon-ana", SECRET, 0)).toBe(legacySalon);
    expect((await controller.salonFeed("salon-ana", legacySalon, res() as any)).statusCode).toBe(200);
    expect((await controller.professionalFeed("pro-1", legacyPro, res() as any)).statusCode).toBe(200);
    expect((await controller.staffFeed("user-1", legacyStaff, res() as any)).statusCode).toBe(200);
  });

  it("rotating revokes every old link and the new ones work", async () => {
    const { controller } = build();

    const out = await controller.rotateTokens({ user: { tenantId: "t1" } });

    expect(out.version).toBe(1);
    expect(out.rotatedAt).toBe("2026-10-31T10:00:00.000Z");
    expect(out.salon.token).not.toBe(legacySalon);
    await expect(controller.salonFeed("salon-ana", legacySalon, res() as any)).rejects.toThrow("Invalid token");
    await expect(controller.professionalFeed("pro-1", legacyPro, res() as any)).rejects.toThrow("Invalid token");
    await expect(controller.staffFeed("user-1", legacyStaff, res() as any)).rejects.toThrow("Invalid token");

    expect((await controller.salonFeed("salon-ana", out.salon.token, res() as any)).statusCode).toBe(200);
    expect((await controller.professionalFeed("pro-1", out.professionals[0].token, res() as any)).statusCode).toBe(200);
    const staffToken = IcsController.signToken("staff:user-1", SECRET, 1);
    expect((await controller.staffFeed("user-1", staffToken, res() as any)).statusCode).toBe(200);
  });

  it("each rotation revokes the previous one", async () => {
    const { controller } = build();
    const first = await controller.rotateTokens({ user: { tenantId: "t1" } });
    const second = await controller.rotateTokens({ user: { tenantId: "t1" } });

    expect(second.version).toBe(2);
    await expect(controller.salonFeed("salon-ana", first.salon.token, res() as any)).rejects.toThrow("Invalid token");
    expect((await controller.salonFeed("salon-ana", second.salon.token, res() as any)).statusCode).toBe(200);
  });

  it("rotates only the caller's salon, in one UPDATE filtered by its id", async () => {
    const { controller, raw } = build();
    await controller.rotateTokens({ user: { tenantId: "t1" } });

    expect(raw).toHaveLength(1);
    expect(raw[0].sql).toMatch(/UPDATE "tenants"/);
    expect(raw[0].sql).toMatch(/jsonb_set/);
    expect(raw[0].sql).toMatch(/WHERE "id" = \?/);
    expect(raw[0].values).toEqual(["t1"]);
  });

  it("a versioned input cannot collide with a real scope", () => {
    expect(IcsController.signToken("salon:x", SECRET, 1)).not.toBe(IcsController.signToken("salon:x", SECRET, 0));
    // Every real scope starts with salon:/professional:/staff:, never "v<n>:".
    expect(IcsController.signToken("salon:x", SECRET, 1)).toBe(IcsController.signToken("v1:salon:x", SECRET, 0));
  });

  it("an unknown id answers like a bad token, not 404", async () => {
    const { controller } = build();
    const forged = IcsController.signToken("salon:nope", SECRET);

    await expect(controller.salonFeed("nope", forged, res() as any)).rejects.toThrow(BadRequestException);
    await expect(
      controller.professionalFeed("pro-9", IcsController.signToken("professional:pro-9", SECRET), res() as any),
    ).rejects.toThrow(BadRequestException);
  });

  it("still requires a token", async () => {
    const { controller } = build();
    await expect(controller.salonFeed("salon-ana", "", res() as any)).rejects.toThrow("token query param required");
  });

  it("reads anything but a positive integer as version 0", () => {
    expect(icsFeedVersion(undefined)).toBe(0);
    expect(icsFeedVersion({})).toBe(0);
    expect(icsFeedVersion({ icsFeed: { version: "3" } })).toBe(0);
    expect(icsFeedVersion({ icsFeed: { version: -1 } })).toBe(0);
    expect(icsFeedVersion({ icsFeed: { version: 1.5 } })).toBe(0);
    expect(icsFeedVersion({ icsFeed: { version: 4 } })).toBe(4);
  });
});

describe("ICS feeds of someone who has left", () => {
  const proToken = IcsController.signToken("professional:pro-1", SECRET);
  const staffToken = IcsController.signToken("staff:user-1", SECRET);

  it("a deactivated professional's feed stops answering", async () => {
    const { controller } = build({}, { professionalActive: false });
    await expect(controller.professionalFeed("pro-1", proToken, res() as any)).rejects.toThrow(NotFoundException);
  });

  it("so does the feed of a login that was taken away", async () => {
    const { controller } = build({}, { userActive: false });
    await expect(controller.staffFeed("user-1", staffToken, res() as any)).rejects.toThrow(NotFoundException);
  });
});
