import { ProfessionalsController } from "./professionals.controller";
import { ProfessionalsService } from "./professionals.service";
import { AdminProfessionalsService } from "../admin/professionals/professionals.service";
import { AdminProfessionalsController } from "../admin/professionals/professionals.controller";
import { bodyParser } from "../common/validation/validated-body.testing";
import { commissionRateUpdate, optionalDateUpdate } from "./optional-fields";

/**
 * A professional's commission rate survives updates that do not mention it.
 *
 * update() wrote `commissionRate: dto.commissionRate ? parseFloat(...) : null`:
 * any update without the rate (a schedule change, a phone number) wiped it,
 * and a rate of 0 was stored as "none". Now: left out keeps it, null clears
 * it, a number -- 0 included -- sets it. The same for create (0 kept) and for
 * terminationDate, which null could not clear.
 */

function setup(stored: Record<string, unknown> = { id: "pro-1", tenantId: "t1", isActive: true, commissionRate: 40 }) {
  const update = jest.fn(async (args: any) => ({ ...stored, ...args.data }));
  const create = jest.fn(async (args: any) => ({ id: "pro-1", ...args.data }));
  const prisma: any = {
    tenant: { findUnique: async () => null },
    professional: { findUnique: async () => stored, update, create },
  };
  return { svc: new ProfessionalsService(prisma), update, create, prisma };
}

describe("commissionRateUpdate / optionalDateUpdate", () => {
  it("undefined leaves it, null and empty clear it, a number sets it (0 included)", () => {
    expect(commissionRateUpdate(undefined)).toBeUndefined();
    expect(commissionRateUpdate(null)).toBeNull();
    expect(commissionRateUpdate("")).toBeNull();
    expect(commissionRateUpdate(0)).toBe(0);
    expect(commissionRateUpdate("0")).toBe(0);
    expect(commissionRateUpdate(12.5)).toBe(12.5);
    expect(commissionRateUpdate("12.5")).toBe(12.5);
    expect(commissionRateUpdate("abc")).toBeUndefined();
  });

  it("dates: undefined leaves it, null clears it, a value sets it", () => {
    expect(optionalDateUpdate(undefined)).toBeUndefined();
    expect(optionalDateUpdate(null)).toBeNull();
    expect(optionalDateUpdate("2026-11-01")).toEqual(new Date("2026-11-01"));
  });
});

describe("PUT /professionals/:id (ProfessionalsService.update)", () => {
  it("keeps the commission rate when the update does not mention it", async () => {
    const { svc, update } = setup();
    await svc.update("pro-1", { phone: "+34600000000" } as any);
    expect(update.mock.calls[0][0].data.commissionRate).toBeUndefined();
  });

  it("sets a rate of 0", async () => {
    const { svc, update } = setup();
    await svc.update("pro-1", { commissionRate: 0 } as any);
    expect(update.mock.calls[0][0].data.commissionRate).toBe(0);
  });

  it("clears the rate with null", async () => {
    const { svc, update } = setup();
    await svc.update("pro-1", { commissionRate: null } as any);
    expect(update.mock.calls[0][0].data.commissionRate).toBeNull();
  });

  it("keeps the termination date when left out, clears it with null", async () => {
    const { svc, update } = setup();
    await svc.update("pro-1", { firstName: "Ana" } as any);
    expect(update.mock.calls[0][0].data.terminationDate).toBeUndefined();
    await svc.update("pro-1", { terminationDate: null } as any);
    expect(update.mock.calls[1][0].data.terminationDate).toBeNull();
  });
});

describe("POST /professionals (ProfessionalsService.create)", () => {
  it("stores a rate of 0 as 0, and none when not given", async () => {
    const { svc, create } = setup();
    await svc.create("t1", { firstName: "Ana", lastName: "G", email: "a@salon.test", commissionRate: 0 } as any);
    expect(create.mock.calls[0][0].data.commissionRate).toBe(0);
    await svc.create("t1", { firstName: "Eva", lastName: "G", email: "e@salon.test" } as any);
    expect(create.mock.calls[1][0].data.commissionRate).toBeNull();
  });
});

describe("PUT /professionals/:id body", () => {
  const parse = bodyParser(ProfessionalsController, "update");

  it("takes a number (0 included), a numeric string, or null; leaves it out when not sent", async () => {
    expect((await parse({ commissionRate: 0 })).commissionRate).toBe(0);
    expect((await parse({ commissionRate: "12.5" })).commissionRate).toBe(12.5);
    expect((await parse({ commissionRate: null })).commissionRate).toBeNull();
    expect((await parse({ commissionRate: "" })).commissionRate).toBeNull();
    expect((await parse({ phone: "+34600000000" })).commissionRate).toBeUndefined();
  });

  it("refuses a rate that is not a number", async () => {
    await expect(parse({ commissionRate: "abc" })).rejects.toBeDefined();
  });
});

describe("POST /admin/professionals (AdminProfessionalsService.create)", () => {
  it("stores a rate of 0 as 0", async () => {
    const create = jest.fn(async (args: any) => ({ id: "pro-1", ...args.data }));
    const tx: any = {
      professional: { create, findUnique: async () => null, findFirst: async () => null },
      user: { findUnique: async () => null, findFirst: async () => null },
      professionalService: { createMany: async () => ({}) },
    };
    const prisma: any = {
      ...tx,
      // Found: the create goes ahead. findUnique null: no plan limit to check.
      tenant: { findUnique: async () => null, findFirst: async () => ({ id: "t1" }) },
      $transaction: async (fn: any) => (typeof fn === "function" ? fn(tx) : Promise.all(fn)),
    };
    const svc = new AdminProfessionalsService(prisma);
    await svc.create({ tenantId: "t1", firstName: "Ana", lastName: "G", email: "a@salon.test", commissionRate: 0 } as any);
    expect(create.mock.calls[0][0].data.commissionRate).toBe(0);
  });
});

/**
 * The professionals list's edit modal (dashboard/professionals/page.tsx)
 * saves through PATCH /admin/professionals/:id: 0 sets a rate of 0, null
 * clears it, left out keeps it.
 */
describe("PATCH /admin/professionals/:id (AdminProfessionalsController.update)", () => {
  const parse = bodyParser(AdminProfessionalsController, "update");

  it("the body takes 0 and null, and leaves the rate out when not sent", async () => {
    expect((await parse({ commissionRate: 0 })).commissionRate).toBe(0);
    expect((await parse({ commissionRate: 12.5 })).commissionRate).toBe(12.5);
    expect((await parse({ commissionRate: null })).commissionRate).toBeNull();
    expect("commissionRate" in (await parse({ phone: "+34600000000" }))).toBe(false);
  });

  it("refuses a rate that is not a number", async () => {
    await expect(parse({ commissionRate: "abc" })).rejects.toBeDefined();
  });

  function adminSetup() {
    const update = jest.fn(async (args: any) => ({ id: "pro-1", commissionRate: 40, ...args.data }));
    const prisma: any = {
      professional: { update, findFirst: async () => ({ isActive: true }) },
      professionalService: { deleteMany: jest.fn(), createMany: jest.fn() },
    };
    return { svc: new AdminProfessionalsService(prisma), update };
  }

  it("stores 0 as 0", async () => {
    const { svc, update } = adminSetup();
    await svc.update("t1", "pro-1", { commissionRate: 0 } as any);
    expect(update.mock.calls[0][0].data.commissionRate).toBe(0);
  });

  it("clears the rate with null", async () => {
    const { svc, update } = adminSetup();
    await svc.update("t1", "pro-1", { commissionRate: null } as any);
    expect(update.mock.calls[0][0].data.commissionRate).toBeNull();
  });

  it("keeps the rate when the update does not mention it", async () => {
    const { svc, update } = adminSetup();
    await svc.update("t1", "pro-1", { isActive: true, phone: "+34600000000" } as any);
    expect(update.mock.calls[0][0].data).not.toHaveProperty("commissionRate");
  });
});
