import { plainToInstance } from "class-transformer";
import { validateSync } from "class-validator";
import { BadRequestException } from "@nestjs/common";
import { UpdateTenantDto } from "./dto/update-tenant.dto";
import { AuthService } from "./auth.service";

/**
 * /dashboard/settings showed invented business data ("Kira Room", "Calle
 * Principal 123", 09:00-20:00...) and saved only language, currency and
 * timezone while reporting everything as saved. PATCH /auth/tenant now takes
 * the rest of what the page edits that the tenant actually stores.
 */

const errorsFor = (body: object) =>
  validateSync(plainToInstance(UpdateTenantDto, body), {
    whitelist: true,
    forbidNonWhitelisted: true,
  }).map((e) => e.property);

describe("UpdateTenantDto", () => {
  it("accepts the settings page's fields", () => {
    expect(
      errorsFor({
        name: "Salón Ana",
        street: "Calle Mayor 1",
        phone: "600000000",
        email: "hola@salon.test",
        minCancelHours: 24,
        openingHours: { open: "09:30", close: "19:00" },
        dateFormat: "DD/MM/YYYY",
        timeFormat: "24h",
      }),
    ).toEqual([]);
  });

  it("rejects malformed values", () => {
    expect(errorsFor({ email: "not-an-email" })).toEqual(["email"]);
    expect(errorsFor({ minCancelHours: -1 })).toEqual(["minCancelHours"]);
    expect(errorsFor({ openingHours: { open: "9", close: "25:00" } })).toEqual(["openingHours"]);
  });
});

describe("updateTenant", () => {
  it("merges the opening window into openingHours instead of replacing it", async () => {
    // Onboarding keeps other keys in the same JSON.
    let written: any;
    const prisma: any = {
      tenant: {
        findUnique: async () => ({ openingHours: { monday: ["09:00", "18:00"], open: "08:00", close: "20:00" } }),
        update: async ({ data }: any) => { written = data; return data; },
      },
    };
    const service = Object.create(AuthService.prototype);
    service.prisma = prisma;

    await service.updateTenant("t1", { name: "X", openingHours: { open: "10:00", close: "19:00" } });

    expect(written).toEqual({
      name: "X",
      openingHours: { monday: ["09:00", "18:00"], open: "10:00", close: "19:00" },
    });
  });
  it("refuses a window that opens at or after it closes", async () => {
    // getAvailableSlots builds the grid from it: reversed, the salon had no
    // bookable slot at all, and nothing said why.
    let written = false;
    const service = Object.create(AuthService.prototype);
    service.prisma = { tenant: { findUnique: async () => ({}), update: async () => { written = true; } } };

    await expect(
      service.updateTenant("t1", { openingHours: { open: "20:00", close: "09:00" } }),
    ).rejects.toThrow(BadRequestException);
    await expect(
      service.updateTenant("t1", { openingHours: { open: "09:00", close: "09:00" } }),
    ).rejects.toThrow(BadRequestException);
    expect(written).toBe(false);
  });
});
