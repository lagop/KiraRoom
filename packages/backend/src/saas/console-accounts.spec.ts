/**
 * Accounts the platform console creates and lists (audit 8, C1 and C5).
 */
jest.mock("./saas.helpers", () => {
  const actual = jest.requireActual("./saas.helpers");
  return {
    ...actual,
    assertTenantSlugAvailable: jest.fn(async () => undefined),
    createTenantWithOwner: jest.fn(async () => ({ tenant: { id: "t1" } })),
  };
});

import { createTenantWithOwner } from "./saas.helpers";
import { CONSOLE_TENANT_SORT_FIELDS, CONSOLE_USER_SELECT, SaasService, unusablePassword } from "./saas.service";
import { SaasController } from "./saas.controller";
import { CreateTenantDto } from "./dto/create-tenant.dto";
import { bodyParser } from "../common/validation/validated-body.testing";
import * as fs from "fs";
import * as path from "path";

function makeService() {
  const prisma: any = {
    tenant: {
      findUniqueOrThrow: jest.fn(async () => ({ id: "t1" })),
      // createTenant returns the console view (getTenantById, audit 8 T24).
      findUnique: jest.fn(async () => ({ id: "t1", name: "S", subscriptionStatus: "trialing", readOnlyUntil: null, users: [], _count: { users: 1, clients: 0, appointments: 0, professionals: 0, services: 0, payments: 0 } })),
      findMany: jest.fn(async () => []),
    },
    user: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) },
  };
  const passwordReset = { request: jest.fn(async () => undefined) };
  const service = new SaasService(prisma, {} as any, {} as any, {} as any, passwordReset as any);
  return { service, prisma, passwordReset };
}

const base = { name: "Salón Luna", plan: "esencial" as any, ownerEmail: "luna@salon.test", ownerFirstName: "Ana", ownerLastName: "Ruiz" };

describe("console: new salon without a password (C1)", () => {
  beforeEach(() => (createTenantWithOwner as jest.Mock).mockClear());

  it("gives the owner a random password and emails her a link to choose one", async () => {
    const { service, passwordReset } = makeService();
    await service.createTenant(Object.assign(new CreateTenantDto(), base));
    await service.createTenant(Object.assign(new CreateTenantDto(), { ...base, ownerEmail: "otra@salon.test" }));
    const [first, second] = (createTenantWithOwner as jest.Mock).mock.calls.map((c) => c[1].ownerPassword);
    expect(first).toHaveLength(43);
    expect(first).not.toBe(second);
    expect(passwordReset.request).toHaveBeenCalledWith("luna@salon.test");
  });

  it("keeps a password the console set, and sends no link", async () => {
    const { service, passwordReset } = makeService();
    const chosen = ["Luna", "2026", "segura"].join("-");
    await service.createTenant(Object.assign(new CreateTenantDto(), { ...base, ownerPassword: chosen }));
    expect((createTenantWithOwner as jest.Mock).mock.calls[0][1].ownerPassword).toBe(chosen);
    expect(passwordReset.request).not.toHaveBeenCalled();
  });

  it("random passwords are not repeated", () => {
    expect(new Set(Array.from({ length: 50 }, unusablePassword)).size).toBe(50);
  });

  it("refuses a short password like signup, and treats an empty one as not sent", async () => {
    const parse = bodyParser(SaasController, "createTenant");
    await expect(parse({ ...base, ownerPassword: "1" })).rejects.toBeDefined();
    await expect(parse({ ...base, ownerPassword: "x".repeat(129) })).rejects.toBeDefined();
    const empty = await parse({ ...base, ownerPassword: "" });
    expect(empty.ownerPassword).toBeUndefined();
  });

  it("no shared default password is left in the console code", () => {
    const src = fs.readFileSync(path.join(__dirname, "saas.service.ts"), "utf8");
    expect(src).not.toMatch(/ownerPassword\s*\|\|\s*["'`]/);
  });
});

describe("console: user list (C5)", () => {
  it("selects only display columns, never credentials", async () => {
    const { service, prisma } = makeService();
    await service.getAllUsers({ page: 1, limit: 10 } as any);
    const args = prisma.user.findMany.mock.calls[0][0];
    expect(args.include).toBeUndefined();
    expect(args.select).toBe(CONSOLE_USER_SELECT);
    for (const secret of [
      "passwordHash",
      "passwordResetToken",
      "emailVerificationToken",
      "twoFactorSecret",
      "twoFactorPendingSecret",
      "twoFactorRecoveryCodes",
      "tokenVersion",
    ]) {
      expect(Object.keys(CONSOLE_USER_SELECT)).not.toContain(secret);
    }
  });

  it("sorts only by listed columns", async () => {
    const { service, prisma } = makeService();
    await service.getAllUsers({ page: 1, limit: 10, sortBy: "passwordHash", sortOrder: "asc" } as any);
    expect(prisma.user.findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: "asc" });
    await service.getAllUsers({ page: 1, limit: 10, sortBy: "email" } as any);
    expect(prisma.user.findMany.mock.calls[1][0].orderBy).toEqual({ email: "desc" });
  });
});

describe("console: tenant list sort", () => {
  it("sorts only by listed columns", async () => {
    const prisma: any = { tenant: { findMany: jest.fn(async () => []), count: jest.fn(async () => 0) } };
    const service = new SaasService(prisma, {} as any, {} as any, {} as any);
    (service as any).sharedIdentity = async () => new Map();
    await service.getAllTenants({ page: 1, limit: 10, sortBy: "stripeSecretKeyEncrypted", sortOrder: "asc" } as any);
    expect(prisma.tenant.findMany.mock.calls[0][0].orderBy).toEqual({ createdAt: "asc" });
    await service.getAllTenants({ page: 1, limit: 10, sortBy: "name" } as any);
    expect(prisma.tenant.findMany.mock.calls[1][0].orderBy).toEqual({ name: "desc" });
    expect(CONSOLE_TENANT_SORT_FIELDS).not.toContain("stripeSecretKeyEncrypted");
  });
});
