import { BadRequestException, UnauthorizedException } from "@nestjs/common";
import { sign } from "jsonwebtoken";
import { tenantForPublicList } from "./public-list-tenant";
import { ServicesController } from "../../services/services.controller";
import { ServicesService } from "../../services/services.service";
import { ProfessionalsController } from "../../professionals/professionals.controller";
import { ProfessionalsService } from "../../professionals/professionals.service";

/**
 * GET /services and GET /professionals are @Public(), so the JWT guard never
 * ran and the tenant scope never applied. Without a ?tenantId= they returned
 * every salon's rows: to nine dashboard screens that call them bare, and to
 * anyone on the internet -- for professionals, with email and phone.
 */

const SECRET = "test-secret";
const bearer = (claims: object, secret = SECRET) => ({
  headers: { authorization: `Bearer ${sign(claims, secret)}` },
});

describe("tenantForPublicList", () => {
  it("uses an explicit tenantId: a salon's public site asking for itself", () => {
    expect(tenantForPublicList({ headers: {} }, "tenant-b", SECRET)).toBe("tenant-b");
  });

  it("prefers the explicit tenantId over the token's", () => {
    // Someone logged into salon A browsing salon B's public page must see B.
    expect(tenantForPublicList(bearer({ tenantId: "tenant-a" }), "tenant-b", SECRET)).toBe("tenant-b");
  });

  it("falls back to the token's tenant: the dashboard", () => {
    expect(tenantForPublicList(bearer({ tenantId: "tenant-a" }), undefined, SECRET)).toBe("tenant-a");
  });

  it("refuses an anonymous request with no tenantId", () => {
    expect(() => tenantForPublicList({ headers: {} }, undefined, SECRET)).toThrow(BadRequestException);
  });

  it("refuses a forged or expired token rather than trusting its claims", () => {
    expect(() =>
      tenantForPublicList(bearer({ tenantId: "tenant-a" }, "not-the-secret"), undefined, SECRET),
    ).toThrow(UnauthorizedException);

    const expired = { headers: { authorization: `Bearer ${sign({ tenantId: "t", exp: 1 }, SECRET)}` } };
    expect(() => tenantForPublicList(expired, undefined, SECRET)).toThrow(UnauthorizedException);
  });

  it("refuses a token without a tenant", () => {
    expect(() => tenantForPublicList(bearer({ role: "saas_owner" }), undefined, SECRET)).toThrow(
      BadRequestException,
    );
  });
});

describe("the list endpoints are never unscoped", () => {
  const original = process.env.JWT_SECRET;
  beforeAll(() => { process.env.JWT_SECRET = SECRET; });
  afterAll(() => { process.env.JWT_SECRET = original; });

  function spyPrisma() {
    const wheres: any[] = [];
    const findMany = async (args: any) => { wheres.push(args.where); return []; };
    return { prisma: { service: { findMany }, professional: { findMany } }, wheres };
  }

  it("GET /services filters by the caller's tenant", async () => {
    const { prisma, wheres } = spyPrisma();
    const controller = new ServicesController(new ServicesService(prisma as any), {} as any);

    await controller.findAll(bearer({ tenantId: "tenant-a" }), undefined);
    expect(wheres).toEqual([{ tenantId: "tenant-a" }]);

    await expect(controller.findAll({ headers: {} }, undefined)).rejects.toThrow(BadRequestException);
    expect(wheres).toHaveLength(1);
  });

  it("GET /professionals filters by the caller's tenant", async () => {
    const { prisma, wheres } = spyPrisma();
    const controller = new ProfessionalsController(new ProfessionalsService(prisma as any), {} as any);

    await controller.findAll(bearer({ tenantId: "tenant-a" }), undefined);
    expect(wheres[0]).toEqual({ tenantId: "tenant-a" });

    await expect(controller.findAll({ headers: {} }, undefined)).rejects.toThrow(BadRequestException);
    expect(wheres).toHaveLength(1);
  });
});
