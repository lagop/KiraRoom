import { BadRequestException, ConflictException } from "@nestjs/common";
import * as bcrypt from "bcryptjs";
import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { ClientsService } from "./clients.service";
import { ChangeMyPasswordDto, UpdateMyProfileDto } from "./dto";

/**
 * The salon site's account page: "Contraseña actualizada" was shown without
 * any request, and saving the profile hit PATCH /clients/:id, which does not
 * exist. These are the endpoints it now uses.
 */

async function setup(password = "old-password-1") {
  const passwordHash = await bcrypt.hash(password, 4);
  const updates: any[] = [];
  const prisma: any = {
    client: {
      findFirst: async ({ where }: any) =>
        where.id === "c1" && where.tenantId === "t1" ? { passwordHash } : null,
      update: async (args: any) => {
        updates.push(args);
        return { id: "c1", ...args.data };
      },
    },
  };
  return { service: new ClientsService(prisma), updates };
}

describe("changeOwnPassword", () => {
  it("replaces the hash when the current password is right", async () => {
    const { service, updates } = await setup();

    await service.changeOwnPassword("t1", "c1", {
      currentPassword: "old-password-1",
      newPassword: "new-password-2",
    });

    expect(updates[0].where).toEqual({ id: "c1", tenantId: "t1" });
    expect(await bcrypt.compare("new-password-2", updates[0].data.passwordHash)).toBe(true);
  });

  it("refuses without the current password: a borrowed session is not enough", async () => {
    const { service, updates } = await setup();

    await expect(
      service.changeOwnPassword("t1", "c1", { currentPassword: "guess", newPassword: "new-password-2" }),
    ).rejects.toThrow(BadRequestException);
    expect(updates).toHaveLength(0);
  });

  it("requires at least 8 characters, like registration", () => {
    const errors = validateSync(
      plainToInstance(ChangeMyPasswordDto, { currentPassword: "x", newPassword: "short" }),
    );
    expect(errors.map((e) => e.property)).toEqual(["newPassword"]);
  });
});

describe("updateSelf", () => {
  it("updates only the caller's own record in their salon", async () => {
    const { service, updates } = await setup();

    await service.updateSelf("t1", "c1", { firstName: "Ana" });

    expect(updates[0].where).toEqual({ id: "c1", tenantId: "t1" });
    expect(updates[0].data).toEqual({ firstName: "Ana" });
  });

  it("reports an email already used in the salon as a conflict", async () => {
    const prisma: any = {
      client: { update: async () => { throw Object.assign(new Error("dup"), { code: "P2002" }); } },
    };
    await expect(new ClientsService(prisma).updateSelf("t1", "c1", { email: "x@y.z" })).rejects.toThrow(
      ConflictException,
    );
  });

  it("does not let a client touch fields the salon owns", () => {
    // The whitelist strips anything not declared on the DTO.
    const dto = plainToInstance(UpdateMyProfileDto, { firstName: "Ana", status: "blocked", taxId: "X" });
    const errors = validateSync(dto, { whitelist: true, forbidNonWhitelisted: true });
    expect(errors.map((e) => e.property).sort()).toEqual(["status", "taxId"]);
  });
});
