import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from "@nestjs/common";
import { UserRole } from "@prisma/client";
import { AdminProfessionalsService, LOGIN_EMAIL_TAKEN, MAX_PROFESSIONALS_PAGE } from "./professionals.service";
import { AdminProfessionalsController } from "./professionals.controller";
import { bodyParser } from "../../common/validation/validated-body.testing";

/**
 * The team screen (Equipo): editing, deactivating and listing professionals.
 *
 * - Editing from the list drawer always failed: it sends the hire date as
 *   "YYYY-MM-DD", which was written to Prisma raw.
 * - Deactivating left the professional's own panel login on.
 * - Reactivation and adds counted the plan's places without a lock.
 * - A new email on the record left the login on the old one.
 * - Prisma's own (English) error text reached the salon.
 * - The list stopped at 10 and loaded every appointment of everyone.
 */

const TENANT = "11111111-1111-4111-8111-111111111111";

function db(stored: Record<string, any> | null, opts: { plan?: string; active?: number; userWithEmail?: { id: string } | null } = {}) {
  const prisma: any = {
    professional: {
      findFirst: jest.fn(async () => stored),
      update: jest.fn(async (args: any) => ({ id: "p1", tenantId: TENANT, ...args.data })),
      create: jest.fn(async (args: any) => ({ id: "p-new", ...args.data })),
      count: jest.fn(async () => opts.active ?? 0),
      findMany: jest.fn(async () => []),
    },
    tenant: {
      findFirst: jest.fn(async () => ({ id: TENANT })),
      // No tenant: no plan limit, unless a plan is given.
      findUnique: jest.fn(async () =>
        opts.plan ? { plan: opts.plan, subscriptionStatus: "active", trialEnd: null } : null,
      ),
    },
    user: {
      findUnique: jest.fn(async () => opts.userWithEmail ?? null),
      update: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    appointment: { count: jest.fn(async () => 3) },
    professionalService: { deleteMany: jest.fn(), createMany: jest.fn() },
    $executeRaw: jest.fn(async () => 1),
  };
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  return { prisma, svc: new AdminProfessionalsService(prisma) };
}

const staffLogin = { id: "u-ana", role: UserRole.staff, email: "ana@salon.test" };
const ana = (over: Record<string, any> = {}) => ({ isActive: true, email: "ana@salon.test", user: null, ...over });

describe("editing a professional (PATCH /admin/professionals/:id)", () => {
  it("turns the form's dates into Dates (raw, Prisma refused them: every edit was a 400)", async () => {
    const { svc, prisma } = db(ana());
    await svc.update(TENANT, "p1", { hireDate: "2024-03-01", terminationDate: "2026-12-31" } as any);
    const { data } = prisma.professional.update.mock.calls[0][0];
    expect(data.hireDate).toEqual(new Date("2024-03-01"));
    expect(data.terminationDate).toEqual(new Date("2026-12-31"));
  });

  it("leaves the dates alone when not sent, and clears the termination date with null", async () => {
    const { svc, prisma } = db(ana());
    await svc.update(TENANT, "p1", { phone: "600000000" } as any);
    await svc.update(TENANT, "p1", { terminationDate: null } as any);
    expect(prisma.professional.update.mock.calls[0][0].data.hireDate).toBeUndefined();
    expect(prisma.professional.update.mock.calls[0][0].data.terminationDate).toBeUndefined();
    expect(prisma.professional.update.mock.calls[1][0].data.terminationDate).toBeNull();
  });

  it("never moves the professional to the salon a body names", async () => {
    const { svc, prisma } = db(ana());
    await svc.update(TENANT, "p1", { tenantId: "another-salon", phone: "1" } as any);
    expect(prisma.professional.update.mock.calls[0][0].data).not.toHaveProperty("tenantId");
  });

  it("is a Spanish 404 for someone not in this salon", async () => {
    const { svc } = db(null);
    await expect(svc.update(TENANT, "p1", { phone: "1" } as any)).rejects.toThrow("Profesional no encontrado");
  });

  it("never passes Prisma's own error text on", async () => {
    const { svc, prisma } = db(ana());
    prisma.professional.update.mockRejectedValueOnce(new Error('Invalid `prisma.professional.update()` invocation: column "x"'));
    const err = await svc.update(TENANT, "p1", { phone: "1" } as any).catch((e) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect(err.message).not.toMatch(/prisma|invocation|column/i);
    expect(err.message).toMatch(/No se han podido guardar/);
  });

  it("an email another professional has is a Spanish 409", async () => {
    const { svc, prisma } = db(ana());
    prisma.professional.update.mockRejectedValueOnce(Object.assign(new Error("Unique constraint"), { code: "P2002" }));
    const err = await svc.update(TENANT, "p1", { email: "luis@salon.test" } as any).catch((e) => e);
    expect(err).toBeInstanceOf(ConflictException);
    expect(err.message).toMatch(/email/);
  });
});

describe("deactivating and reactivating", () => {
  it("deactivating takes away their panel login and ends its sessions", async () => {
    const { svc, prisma } = db(ana({ user: staffLogin }));
    await svc.update(TENANT, "p1", { isActive: false } as any);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: "u-ana", tenantId: TENANT, role: UserRole.staff, isActive: true },
      data: { isActive: false, tokenVersion: { increment: 1 } },
    });
  });

  it("never touches the owner's account, whose record this may be", async () => {
    const { svc, prisma } = db(ana({ user: { ...staffLogin, role: UserRole.owner } }));
    await svc.update(TENANT, "p1", { isActive: false } as any);
    // The where of revokePanelLogin only matches staff accounts.
    expect(prisma.user.updateMany.mock.calls[0][0].where.role).toBe(UserRole.staff);
  });

  it("reactivating does not give the login back", async () => {
    const { svc, prisma } = db(ana({ isActive: false, user: staffLogin }));
    await svc.update(TENANT, "p1", { isActive: true } as any);
    expect(prisma.user.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("reactivating counts the plan's places under the salon's lock", async () => {
    const { svc, prisma } = db(ana({ isActive: false }), { plan: "esencial", active: 1 });
    await svc.update(TENANT, "p1", { isActive: true } as any);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [sql, key] = prisma.$executeRaw.mock.calls[0];
    expect(sql.join("?")).toContain("pg_advisory_xact_lock");
    expect(key).toBe(`professional-slot:${TENANT}`);
  });

  it("and refuses it, with the plan's reason, when the plan is full", async () => {
    const { svc, prisma } = db(ana({ isActive: false }), { plan: "esencial", active: 4 });
    const err = await svc.update(TENANT, "p1", { isActive: true } as any).catch((e) => e);
    expect(err).toBeInstanceOf(ForbiddenException);
    expect(err.getResponse()).toMatchObject({ code: "PROFESSIONAL_LIMIT_REACHED" });
    expect(prisma.professional.update).not.toHaveBeenCalled();
  });

  it("an active professional is created under the same lock", async () => {
    const { svc, prisma } = db(null);
    await svc.create({ tenantId: TENANT, firstName: "Ana", lastName: "G", email: "a@salon.test" } as any);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    expect(prisma.professional.create).toHaveBeenCalledTimes(1);
  });

  it("counts the appointments still to happen, for the confirmation", async () => {
    const { svc, prisma } = db({ id: "p1" });
    expect(await svc.upcomingAppointmentCount(TENANT, "p1")).toEqual({ count: 3 });
    const { where } = prisma.appointment.count.mock.calls[0][0];
    expect(where).toMatchObject({ tenantId: TENANT, professionalId: "p1", status: { in: ["pending", "confirmed", "in_progress"] } });
    await expect(db(null).svc.upcomingAppointmentCount(TENANT, "p1")).rejects.toBeInstanceOf(NotFoundException);
  });

  it("access to the panel cannot be given to an inactive professional", async () => {
    const { svc } = db({ id: "p1", tenantId: TENANT, firstName: "Ana", lastName: "G", email: "a@salon.test", isActive: false, user: null });
    await expect(svc.grantPanelAccess(TENANT, "p1", "primera-clave-2026")).rejects.toThrow(/desactivado/);
  });
});

describe("a new email on the record moves the login", () => {
  it("updates the account's email too", async () => {
    const { svc, prisma } = db(ana({ user: staffLogin }));
    await svc.update(TENANT, "p1", { email: "Ana.Nueva@Salon.test" } as any);
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: "u-ana" }, data: { email: "ana.nueva@salon.test" } });
  });

  it("refuses an email another account signs in with, before saving anything", async () => {
    const { svc, prisma } = db(ana({ user: staffLogin }), { userWithEmail: { id: "someone-else" } });
    await expect(svc.update(TENANT, "p1", { email: "taken@salon.test" } as any)).rejects.toThrow(LOGIN_EMAIL_TAKEN);
    expect(prisma.professional.update).not.toHaveBeenCalled();
  });

  it("leaves the salon's main account alone, and does nothing without a login or a change", async () => {
    for (const user of [{ ...staffLogin, role: UserRole.owner }, null]) {
      const { svc, prisma } = db(ana({ user }));
      await svc.update(TENANT, "p1", { email: "otro@salon.test" } as any);
      expect(prisma.user.update).not.toHaveBeenCalled();
    }
    const { svc, prisma } = db(ana({ user: staffLogin }));
    await svc.update(TENANT, "p1", { email: "ANA@salon.test" } as any);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("the team list (GET /admin/professionals)", () => {
  it("does not load every appointment of everyone", async () => {
    const { svc, prisma } = db(null);
    await svc.findAll({ tenantId: TENANT, page: 1, limit: 10, search: "" });
    expect(prisma.professional.findMany.mock.calls[0][0].include).not.toHaveProperty("appointments");
  });

  it("returns the whole team by default, up to the cap (it stopped at 10)", async () => {
    const findAll = jest.fn(async (args: any) => args);
    const controller = new AdminProfessionalsController({ findAll } as any);
    expect((await controller.findAll({ tenantId: TENANT })).limit).toBe(MAX_PROFESSIONALS_PAGE);
    expect((await controller.findAll({ tenantId: TENANT }, "1", "5000")).limit).toBe(MAX_PROFESSIONALS_PAGE);
    expect((await controller.findAll({ tenantId: TENANT }, "1", "25")).limit).toBe(25);
  });
});

describe("PATCH /admin/professionals/:id body", () => {
  const parse = bodyParser(AdminProfessionalsController, "update");

  it("takes a commission as a percent, 0 to 100", async () => {
    expect((await parse({ commissionRate: 40 })).commissionRate).toBe(40);
    await expect(parse({ commissionRate: 150 })).rejects.toBeDefined();
    await expect(parse({ commissionRate: -5 })).rejects.toBeDefined();
  });

  it("refuses an email that is not one", async () => {
    await expect(parse({ email: "not-an-email" })).rejects.toBeDefined();
    expect((await parse({ email: "ana@salon.test" })).email).toBe("ana@salon.test");
  });

  it("takes the form's dates; an emptied termination date clears it", async () => {
    const body = await parse({ hireDate: "2024-03-01", terminationDate: "" });
    expect(body.hireDate).toBe("2024-03-01");
    expect(body.terminationDate).toBeNull();
    await expect(parse({ hireDate: "ayer" })).rejects.toBeDefined();
  });
});
