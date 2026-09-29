import { BadRequestException, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { JwtService } from "@nestjs/jwt";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { sign } from "jsonwebtoken";
import { PublicViewerService } from "./public-viewer.service";
import { ServicesController } from "../../services/services.controller";
import { ServicesService } from "../../services/services.service";
import { ProfessionalsController } from "../../professionals/professionals.controller";
import { ProfessionalsService, PUBLIC_PROFESSIONAL } from "../../professionals/professionals.service";
import { CreateProfessionalDto as AdminCreateProfessionalDto } from "../../admin/professionals/dto/create-professional.dto";

/**
 * GET /services, GET /professionals and GET /professionals/:id are @Public(),
 * so the JWT guard never ran and the tenant scope never applied. Without a
 * ?tenantId= the lists returned every salon's rows; with one -- and a salon's
 * id is public via /public-site/tenant/:slug -- professionals still came with
 * email, phone and commission rate. By id, the same, to anyone.
 */

const SECRET = "test-secret";
const bearer = (claims: object, secret = SECRET) => ({
  headers: { authorization: `Bearer ${sign(claims, secret)}` },
});
const OWNER_A = { sub: "user-a", role: "owner", tenantId: "tenant-a" };
const CLIENT_A = { sub: "client-a", role: "client", tenantId: "tenant-a" };

function viewerService(users: Record<string, { isActive: boolean; tenantId: string }> = {
  "user-a": { isActive: true, tenantId: "tenant-a" },
}) {
  const prisma: any = { user: { findUnique: async ({ where }: any) => users[where.id] ?? null } };
  const config: any = { get: (k: string) => (k === "JWT_SECRET" ? SECRET : undefined) };
  return new PublicViewerService(new JwtService({}), config, prisma);
}

describe("PublicViewerService.resolve", () => {
  it("answers an explicit tenantId for anyone, as a public viewer", async () => {
    expect(await viewerService().resolve({ headers: {} }, "tenant-b")).toEqual({ tenantId: "tenant-b", staff: false });
  });

  it("does not make staff of salon A staff of salon B", async () => {
    expect(await viewerService().resolve(bearer(OWNER_A), "tenant-b")).toEqual({ tenantId: "tenant-b", staff: false });
  });

  it("falls back to the token's salon, staff when the user is active staff there", async () => {
    expect(await viewerService().resolve(bearer(OWNER_A))).toEqual({ tenantId: "tenant-a", staff: true });
  });

  it("treats a client as a public viewer of their own salon", async () => {
    expect(await viewerService().resolve(bearer(CLIENT_A))).toEqual({ tenantId: "tenant-a", staff: false });
  });

  it("does not treat a deactivated user as staff", async () => {
    const svc = viewerService({ "user-a": { isActive: false, tenantId: "tenant-a" } });
    expect(await svc.resolve(bearer(OWNER_A))).toEqual({ tenantId: "tenant-a", staff: false });
  });

  it("ignores a bad token next to an explicit tenantId: a stale session must not break a public page", async () => {
    expect(await viewerService().resolve(bearer(OWNER_A, "wrong"), "tenant-a")).toEqual({
      tenantId: "tenant-a",
      staff: false,
    });
  });

  it("refuses to list anything without a tenant", async () => {
    await expect(viewerService().resolve({ headers: {} })).rejects.toThrow(BadRequestException);
    await expect(viewerService().resolve(bearer(OWNER_A, "wrong"))).rejects.toThrow(UnauthorizedException);
    await expect(viewerService().resolve(bearer({ sub: "x", role: "saas_owner" }))).rejects.toThrow(
      BadRequestException,
    );
  });
});

const FULL_PRO = {
  id: "pro-1",
  tenantId: "tenant-a",
  firstName: "Ana",
  lastName: "López",
  email: "ana@salon.test",
  phone: "600000000",
  commissionRate: 40,
  userId: "user-ana",
  isActive: true,
  services: [],
};

function professionalsController() {
  const calls: any[] = [];
  const prisma: any = {
    professional: {
      findMany: async (args: any) => { calls.push(args); return [FULL_PRO]; },
      findUnique: async () => FULL_PRO,
    },
  };
  const controller = new ProfessionalsController(new ProfessionalsService(prisma), {} as any, viewerService());
  return { controller, calls };
}

describe("GET /professionals", () => {
  it("gives the public projection, active only, to an anonymous caller", async () => {
    const { controller, calls } = professionalsController();

    await controller.findAll({ headers: {} }, "tenant-a");

    expect(calls[0].where).toEqual({ tenantId: "tenant-a", isActive: true });
    expect(calls[0].select).toBe(PUBLIC_PROFESSIONAL);
    for (const secret of ["email", "phone", "commissionRate", "userId", "hireDate", "settings", "stats"]) {
      expect(PUBLIC_PROFESSIONAL).not.toHaveProperty(secret);
    }
  });

  it("gives full rows to the salon's own staff", async () => {
    const { controller, calls } = professionalsController();

    await controller.findAll(bearer(OWNER_A), undefined);

    expect(calls[0].where).toEqual({ tenantId: "tenant-a" });
    expect(calls[0].select).toBeUndefined();
  });
});

describe("GET /professionals/:id", () => {
  it("strips private fields for anyone but the salon's staff", async () => {
    const { controller } = professionalsController();

    const pub: any = await controller.findOne({ headers: {} }, "pro-1");
    expect(pub).toMatchObject({ id: "pro-1", firstName: "Ana" });
    expect(pub.email).toBeUndefined();
    expect(pub.phone).toBeUndefined();
    expect(pub.commissionRate).toBeUndefined();

    const full: any = await controller.findOne(bearer(OWNER_A), "pro-1");
    expect(full.email).toBe("ana@salon.test");
  });

  it("does not show an inactive professional publicly", async () => {
    const prisma: any = { professional: { findUnique: async () => ({ ...FULL_PRO, isActive: false }) } };
    const controller = new ProfessionalsController(new ProfessionalsService(prisma), {} as any, viewerService());
    await expect(controller.findOne({ headers: {} }, "pro-1")).rejects.toThrow(NotFoundException);
  });
});

describe("GET /services", () => {
  it("is scoped to the caller's salon and never unscoped", async () => {
    const wheres: any[] = [];
    const prisma: any = { service: { findMany: async (args: any) => { wheres.push(args.where); return []; } } };
    const controller = new ServicesController(new ServicesService(prisma), {} as any, viewerService());

    await controller.findAll(bearer(OWNER_A), undefined);
    expect(wheres).toEqual([{ tenantId: "tenant-a" }]);

    await expect(controller.findAll({ headers: {} }, undefined)).rejects.toThrow(BadRequestException);
    expect(wheres).toHaveLength(1);
  });
});

describe("POST /admin/professionals body", () => {
  it("validates without a tenantId, which the dashboard no longer sends", () => {
    // Required here, it made every professional create a 400 -- onboarding
    // included -- once the frontend stopped sending placeholders.
    const dto = plainToInstance(AdminCreateProfessionalDto, {
      firstName: "Ana",
      lastName: "López",
      email: "ana@salon.test",
    });
    expect(validateSync(dto).map((e) => e.property)).toEqual([]);
  });
});
