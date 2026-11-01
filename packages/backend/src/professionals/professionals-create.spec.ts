import { ProfessionalsController } from "./professionals.controller";
import { ProfessionalsService } from "./professionals.service";
import { AdminProfessionalsService } from "../admin/professionals/professionals.service";

/**
 * Creating a professional takes the tenant from the caller's token.
 *
 * The dashboard's professionals screens sent 'default-tenant' (or a tenantId
 * read from localStorage, falling back to it), which the tenant scope
 * rejected with a 403. Same bug as POST /services; see services-create.spec.
 *
 * The legacy POST/PUT/DELETE /professionals (the panel uses
 * /admin/professionals; the E2E suite still creates with POST) go through
 * AdminProfessionalsService, so they follow the same rules.
 */

function setup(stored: Record<string, unknown> = { isActive: true, user: null }) {
  const calls: any[] = [];
  const updates: any[] = [];
  const detected: string[] = [];
  const prisma: any = {
    // findUnique null: the plan's professional limit is not checked here
    // (see professional-limit.spec). findFirst: the salon exists.
    tenant: { findUnique: async () => null, findFirst: async () => ({ id: "tenant-real" }) },
    professional: {
      create: async (args: any) => {
        calls.push(args);
        return { id: "pro-1", ...args.data };
      },
      findFirst: async () => stored,
      update: async (args: any) => {
        updates.push(args);
        return { id: "pro-1", tenantId: "tenant-real", ...args.data };
      },
    },
    user: { updateMany: jest.fn(async () => ({ count: 1 })) },
    professionalService: { deleteMany: jest.fn(), createMany: jest.fn() },
    $executeRaw: jest.fn(async () => 1),
  };
  prisma.$transaction = async (fn: any) => fn(prisma);
  const controller = new ProfessionalsController(
    new ProfessionalsService(prisma),
    { detect: async (t: string) => { detected.push(t); } } as any,
    {} as any,
    new AdminProfessionalsService(prisma),
  );
  return { controller, calls, updates, detected, prisma };
}

const OWNER = { id: "user-1", tenantId: "tenant-real", role: "owner" };

describe("POST /professionals", () => {
  it("creates the professional in the caller's tenant, whatever the body says", async () => {
    const { controller, calls, detected } = setup();

    await controller.create(OWNER, {
      tenantId: "default-tenant",
      firstName: "Ana",
      lastName: "García",
      email: "ana@salon.test",
    } as any);

    expect(calls[0].data.tenantId).toBe("tenant-real");
    expect(detected).toEqual(["tenant-real"]);
  });

  it("honours isActive: false, and takes no plan place for it (no lock)", async () => {
    const { controller, calls, prisma } = setup();

    await controller.create(OWNER, {
      firstName: "Ana",
      lastName: "García",
      email: "ana@salon.test",
      isActive: false,
    } as any);

    expect(calls[0].data.isActive).toBe(false);
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
  });

  it("an active one is created under the salon's lock", async () => {
    const { controller, prisma } = setup();
    await controller.create(OWNER, { firstName: "Ana", lastName: "García", email: "ana@salon.test" } as any);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it("nobody becomes the salon's owner through the API", async () => {
    const { controller, calls } = setup();
    await controller.create(OWNER, { firstName: "Ana", lastName: "García", email: "ana@salon.test", isOwner: true } as any);
    expect(calls[0].data.isOwner).toBe(false);
  });
});

describe("PUT /professionals/:id", () => {
  it("is scoped to the caller's salon and turns the dates into Dates", async () => {
    const { controller, updates } = setup();
    await controller.update(OWNER, "pro-1", { hireDate: "2024-03-01", isOwner: true } as any);
    expect(updates[0].where).toEqual({ id: "pro-1", tenantId: "tenant-real" });
    expect(updates[0].data.hireDate).toEqual(new Date("2024-03-01"));
    expect(updates[0].data).not.toHaveProperty("isOwner");
  });

  it("deactivating also takes away the professional's login", async () => {
    const { controller, prisma } = setup({ isActive: true, user: { id: "u-ana", role: "staff", email: "ana@salon.test" } });
    await controller.update(OWNER, "pro-1", { isActive: false } as any);
    expect(prisma.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { isActive: false, tokenVersion: { increment: 1 } } }),
    );
  });
});
