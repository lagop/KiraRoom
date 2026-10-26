import "reflect-metadata";
import { BadRequestException, ConflictException, ForbiddenException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { UserRole } from "@prisma/client";
import { ROLES_KEY } from "../../auth/decorators/roles.decorator";
import { AdminProfessionalsService, panelAccessOf } from "./professionals.service";
import { AppointmentsService } from "../../appointments/appointments.service";
import { AppointmentsController } from "../../appointments/appointments.controller";

/**
 * Professionals managing their own bookings in the panel. Creating a
 * professional only ever created the record: nobody could give them a login,
 * so none of the staff-side rules could be reached, and they had gaps.
 */

// Cheap hashes: twelve bcrypt rounds per case timed out when the whole suite runs.
process.env.BCRYPT_ROUNDS = "4";

const TENANT = "11111111-1111-4111-8111-111111111111";

function professionalsDb(professional: Record<string, any> | null, opts: { emailTaken?: boolean } = {}) {
  const created: any[] = [];
  const updates: any[] = [];
  const db: any = {
    professional: {
      findFirst: jest.fn(async () => professional),
      update: jest.fn(async (args: any) => (updates.push(["professional", args]), {})),
    },
    user: {
      findUnique: jest.fn(async () => (opts.emailTaken ? { id: "someone" } : null)),
      create: jest.fn(async (args: any) => (created.push(args.data), { id: "new-user" })),
      update: jest.fn(async (args: any) => (updates.push(["user", args]), {})),
    },
  };
  db.$transaction = async (fn: any) => fn(db);
  return { db, created, updates };
}

const ana = { id: "p1", tenantId: TENANT, firstName: "Ana", lastName: "Prueba", email: "Ana@Salon.test", user: null };

describe("giving a professional access to the panel", () => {
  it("creates a staff account with the record's email, linked both ways", async () => {
    const { db, created, updates } = professionalsDb({ ...ana });
    const out = await new AdminProfessionalsService(db).grantPanelAccess(TENANT, "p1", "primera-clave-2026");
    expect(out).toEqual({ active: true, email: "ana@salon.test" });
    expect(created[0]).toMatchObject({ tenantId: TENANT, email: "ana@salon.test", role: UserRole.staff, professionalId: "p1", isActive: true });
    expect(await bcrypt.compare("primera-clave-2026", created[0].passwordHash)).toBe(true);
    expect(updates).toContainEqual(["professional", { where: { id: "p1" }, data: { userId: "new-user" } }]);
  });

  it("needs an email on the record, and one no other account uses", async () => {
    await expect(
      new AdminProfessionalsService(professionalsDb({ ...ana, email: null }).db).grantPanelAccess(TENANT, "p1", "primera-clave-2026"),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      new AdminProfessionalsService(professionalsDb({ ...ana }, { emailTaken: true }).db).grantPanelAccess(TENANT, "p1", "primera-clave-2026"),
    ).rejects.toBeInstanceOf(ConflictException);
  });

  it("again after removing it: reactivated with the new password, old sessions ended", async () => {
    const { db, created, updates } = professionalsDb({ ...ana, user: { id: "u-ana", role: UserRole.staff } });
    await new AdminProfessionalsService(db).grantPanelAccess(TENANT, "p1", "otra-clave-2026");
    expect(created).toHaveLength(0);
    const [, args] = updates.find(([m]) => m === "user");
    expect(args.where).toEqual({ id: "u-ana" });
    expect(args.data).toMatchObject({ isActive: true, tokenVersion: { increment: 1 } });
  });

  it("never touches the owner's own record (another role's account)", async () => {
    const owner = { ...ana, user: { id: "u-owner", role: UserRole.owner } };
    const svc = new AdminProfessionalsService(professionalsDb(owner).db);
    await expect(svc.grantPanelAccess(TENANT, "p1", "primera-clave-2026")).rejects.toBeInstanceOf(BadRequestException);
    await expect(svc.revokePanelAccess(TENANT, "p1")).rejects.toBeInstanceOf(BadRequestException);
  });

  it("an admin cannot reset the owner's password from the team screen", async () => {
    const db: any = {
      professional: { findUnique: jest.fn(async () => ({ ...ana, userId: "u-owner", user: { id: "u-owner", role: UserRole.owner } })) },
      user: { update: jest.fn() },
    };
    await expect(
      new AdminProfessionalsService(db).changePassword(TENANT, "p1", { newPassword: "nueva-clave-2026" }),
    ).rejects.toThrow(/cuenta principal/);
    expect(db.user.update).not.toHaveBeenCalled();
  });

  it("removing access deactivates the account and ends its sessions", async () => {
    const { db, updates } = professionalsDb({ ...ana, user: { id: "u-ana", role: UserRole.staff } });
    expect(await new AdminProfessionalsService(db).revokePanelAccess(TENANT, "p1")).toEqual({ active: false });
    const [, args] = updates.find(([m]) => m === "user");
    expect(args.data).toEqual({ isActive: false, tokenVersion: { increment: 1 } });
  });

  it("the team list says who has access", () => {
    expect(panelAccessOf(null)).toEqual({ status: "none" });
    expect(panelAccessOf({ role: UserRole.staff, isActive: true, email: "a@b.test", lastLoginAt: null })).toMatchObject({ status: "active" });
    expect(panelAccessOf({ role: UserRole.staff, isActive: false, email: "a@b.test", lastLoginAt: null })).toMatchObject({ status: "revoked" });
    expect(panelAccessOf({ role: UserRole.owner, isActive: true, email: "a@b.test", lastLoginAt: null })).toMatchObject({ status: "owner" });
  });
});

describe("what a professional may do with appointments", () => {
  const rolesOf = (method: keyof AppointmentsController) =>
    Reflect.getMetadata(ROLES_KEY, AppointmentsController.prototype[method]) as UserRole[];

  it("edit, move, complete and mark no-show (their own: the service checks), but not delete", () => {
    for (const m of ["update", "complete", "markNoShow", "cancel"] as const) {
      expect(rolesOf(m)).toContain(UserRole.staff);
    }
    expect(rolesOf("remove")).not.toContain(UserRole.staff);
  });

  function service(opts: { professional?: { id: string } | null; crossBooking?: boolean }) {
    const prisma: any = {
      professional: { findFirst: jest.fn(async () => opts.professional ?? null) },
      tenant: { findUnique: jest.fn(async () => ({ allowProfessionalCrossBooking: !!opts.crossBooking })) },
      appointment: { findMany: jest.fn(async () => [{ id: "everyone's" }]) },
    };
    const stub = {} as any;
    const svc = new AppointmentsService(prisma, stub, stub, stub, stub, stub, stub, stub);
    return { svc, prisma };
  }

  it("a staff account not linked to a professional sees no appointment, not the whole salon", async () => {
    const { svc, prisma } = service({ professional: null });
    const staff = { id: "u1", role: "staff", tenantId: TENANT };
    expect(await svc.findAll(staff, {} as any)).toEqual([]);
    expect(await svc.findPendingPayment(staff, {} as any)).toEqual([]);
    expect(prisma.appointment.findMany).not.toHaveBeenCalled();
  });

  it("booking on a colleague's agenda follows the salon's setting", async () => {
    const staff = { id: "u1", role: "staff", tenantId: TENANT, professionalId: "p-me" } as any;
    const dto = { professionalId: "p-colleague" } as any;

    const off = service({ crossBooking: false });
    await expect(off.svc.createByStaff(dto, staff)).rejects.toBeInstanceOf(ForbiddenException);

    const on = service({ crossBooking: true });
    const create = jest.spyOn(on.svc, "create").mockResolvedValue({ id: "a1" } as any);
    await expect(on.svc.createByStaff(dto, staff)).resolves.toEqual({ id: "a1" });
    expect(create).toHaveBeenCalledWith(dto, TENANT);
  });
});
