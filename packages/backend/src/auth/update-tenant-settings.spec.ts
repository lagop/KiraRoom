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

const dtoOf = (body: object) => plainToInstance(UpdateTenantDto, body);
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

describe("UpdateTenantDto.openingHours: the salon's week", () => {
  it("takes shifts per weekday, normalised like a professional's schedule", () => {
    const body = {
      openingHours: [
        { day: "Monday", openTime: "17:00", closeTime: "20:00" },
        { day: "monday", openTime: "10:00", closeTime: "14:00" },
        { day: "saturday", openTime: "10:00", closeTime: "14:00" },
      ],
    };
    expect(errorsFor(body)).toEqual([]);
    expect(dtoOf(body).openingHours).toEqual([
      { day: "monday", openTime: "10:00", closeTime: "14:00" },
      { day: "monday", openTime: "17:00", closeTime: "20:00" },
      { day: "saturday", openTime: "10:00", closeTime: "14:00" },
    ]);
  });

  it("an empty week is \"no salon-level hours\"", () => {
    expect(errorsFor({ openingHours: [] })).toEqual([]);
  });

  it("refuses what a professional's schedule refuses", () => {
    expect(errorsFor({ openingHours: [{ day: "lunes", openTime: "10:00", closeTime: "14:00" }] })).toEqual(["openingHours"]);
    expect(errorsFor({ openingHours: [{ day: "monday", openTime: "14:00", closeTime: "10:00" }] })).toEqual(["openingHours"]);
    expect(
      errorsFor({
        openingHours: [
          { day: "monday", openTime: "10:00", closeTime: "14:00" },
          { day: "monday", openTime: "13:00", closeTime: "20:00" },
        ],
      }),
    ).toEqual(["openingHours"]);
    expect(errorsFor({ openingHours: { mon: { open: "10:00", close: "14:00" } } })).toEqual(["openingHours"]);
  });

  it("still accepts the old { open, close }, as that window every day", () => {
    const dto = dtoOf({ openingHours: { open: "9:30", close: "19:00" } });
    expect(errorsFor({ openingHours: { open: "9:30", close: "19:00" } })).toEqual([]);
    expect(dto.openingHours).toHaveLength(7);
    expect(dto.openingHours![0]).toEqual({ day: "monday", openTime: "09:30", closeTime: "19:00" });
    expect(dto.openingHours![6]).toEqual({ day: "sunday", openTime: "09:30", closeTime: "19:00" });
    expect(errorsFor({ openingHours: { open: "20:00", close: "09:00" } })).toEqual(["openingHours"]);
  });
});

describe("updateTenant", () => {
  it("stores the week whole, replacing what was there", async () => {
    // The old merge kept the onboarding wizard's day keys next to the pair;
    // the week itself is the value now.
    let written: any;
    const prisma: any = {
      tenant: {
        findUnique: async () => ({ openingHours: { monday: ["09:00", "18:00"], open: "08:00", close: "20:00" } }),
        update: async ({ data }: any) => { written = data; return data; },
      },
    };
    const service = Object.create(AuthService.prototype);
    service.prisma = prisma;
    const week = [{ day: "monday", openTime: "10:00", closeTime: "14:00" }];

    await service.updateTenant("t1", { name: "X", openingHours: week });
    expect(written).toEqual({ name: "X", openingHours: week });

    // A legacy pair from a caller that skipped the DTO: the same week, every day.
    await service.updateTenant("t1", { openingHours: { open: "10:00", close: "19:00" } });
    expect(written.openingHours).toHaveLength(7);

    // Left out (or null): untouched.
    await service.updateTenant("t1", { name: "Y", openingHours: null });
    expect(written).toEqual({ name: "Y" });
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
