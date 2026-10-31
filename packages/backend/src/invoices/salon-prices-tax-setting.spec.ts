import "reflect-metadata";
import * as fs from "fs";
import * as path from "path";
import { ArgumentMetadata, BadRequestException, ValidationPipe } from "@nestjs/common";
import { InvoicesController } from "./invoices.controller";
import { UpdateTenantFiscalSettingsDto } from "./dto/invoice.dto";
import {
  NEW_SALON_FISCAL_SETTINGS,
  pricesIncludeTaxOf,
  productTaxRatePercent,
  salonTaxRate,
} from "./salon-tax-settings";
import { createTenantWithOwner } from "../saas/saas.helpers";

/**
 * Each salon decides, in its own fiscal settings, whether the prices it sets
 * on services and products already include its tax (IVA, IGIC or IPSI).
 * A salon from before the setting reads as "tax on top", what KiraRoom always
 * did, so none of its invoices change unless it chooses; a new salon starts
 * with prices that include the tax.
 */

describe("pricesIncludeTaxOf", () => {
  it("a salon from before the setting (no key) keeps the tax on top", () => {
    expect(pricesIncludeTaxOf({ defaultSeries: "A", defaultTaxRate: 21, taxRegime: "iva" })).toBe(false);
    expect(pricesIncludeTaxOf({})).toBe(false);
    expect(pricesIncludeTaxOf(null)).toBe(false);
    expect(pricesIncludeTaxOf(undefined)).toBe(false);
  });

  it("is true only for the boolean true", () => {
    expect(pricesIncludeTaxOf({ pricesIncludeTax: true })).toBe(true);
    expect(pricesIncludeTaxOf({ pricesIncludeTax: false })).toBe(false);
    expect(pricesIncludeTaxOf({ pricesIncludeTax: "true" })).toBe(false);
    expect(pricesIncludeTaxOf({ pricesIncludeTax: 1 })).toBe(false);
  });
});

describe("salonTaxRate and productTaxRatePercent", () => {
  it("the salon's rate, else 21", () => {
    expect(salonTaxRate({ defaultTaxRate: 7 })).toBe(7);
    expect(salonTaxRate({ defaultTaxRate: 0 })).toBe(0);
    expect(salonTaxRate({})).toBe(21);
    expect(salonTaxRate(null)).toBe(21);
  });

  it("a product's own rate is a fraction and becomes a percent", () => {
    expect(productTaxRatePercent("0.21", 7)).toBe(21);
    expect(productTaxRatePercent(0.1, 21)).toBe(10);
    expect(productTaxRatePercent(0.095, 7)).toBe(9.5);
    expect(productTaxRatePercent(0, 21)).toBe(0);
  });

  it("no rate of its own: the salon's", () => {
    expect(productTaxRatePercent(null, 7)).toBe(7);
    expect(productTaxRatePercent(undefined, 21)).toBe(21);
    expect(productTaxRatePercent("x", 21)).toBe(21);
  });

  it("a value above 1 is already a percent", () => {
    expect(productTaxRatePercent(21, 7)).toBe(21);
  });
});

describe("PATCH /invoices/settings/fiscal: pricesIncludeTax", () => {
  const pipe = new ValidationPipe({ transform: true, whitelist: true, forbidNonWhitelisted: false });
  const bodyType = (): unknown =>
    Reflect.getMetadata("design:paramtypes", InvoicesController.prototype, "updateFiscalSettings")[1];
  const parse = (body: unknown) =>
    pipe.transform(body, { type: "body", metatype: bodyType() as any } as ArgumentMetadata);

  it("the body is a validated class", () => {
    expect(bodyType()).toBe(UpdateTenantFiscalSettingsDto);
  });

  it("takes a boolean", async () => {
    await expect(parse({ pricesIncludeTax: true })).resolves.toMatchObject({ pricesIncludeTax: true });
    await expect(parse({ pricesIncludeTax: false })).resolves.toMatchObject({ pricesIncludeTax: false });
  });

  it("refuses anything else", async () => {
    await expect(parse({ pricesIncludeTax: "true" })).rejects.toThrow(BadRequestException);
    await expect(parse({ pricesIncludeTax: 1 })).rejects.toThrow(BadRequestException);
    await expect(parse({ pricesIncludeTax: null })).resolves.toEqual({ pricesIncludeTax: null });
  });

  it("is optional", async () => {
    await expect(parse({ defaultTaxRate: 7 })).resolves.toEqual({ defaultTaxRate: 7 });
  });

  function controllerWith(fiscalSettings: Record<string, unknown>) {
    const update = jest.fn(async (args: { data: { fiscalSettings: unknown } }) => ({
      fiscalMode: "none",
      fiscalSettings: args.data.fiscalSettings,
    }));
    const prisma = {
      tenant: { findUnique: jest.fn(async () => ({ fiscalSettings })), update },
    };
    const controller = new InvoicesController({} as any, {} as any, {} as any, prisma as any);
    const req = { user: { tenantId: "tenant-1" } } as any;
    return { controller, req, update };
  }

  it("is saved into the salon's fiscal settings, keeping the rest", async () => {
    const { controller, req, update } = controllerWith({ defaultSeries: "B", defaultTaxRate: 7, taxRegime: "igic" });
    const dto = Object.assign(new UpdateTenantFiscalSettingsDto(), { pricesIncludeTax: true });
    await controller.updateFiscalSettings(req, dto);
    expect(update.mock.calls[0][0].data.fiscalSettings).toEqual({
      defaultSeries: "B",
      defaultTaxRate: 7,
      taxRegime: "igic",
      pricesIncludeTax: true,
    });
  });

  it("a save that does not send it leaves it as it was", async () => {
    const { controller, req, update } = controllerWith({ defaultTaxRate: 21, pricesIncludeTax: true });
    const dto = Object.assign(new UpdateTenantFiscalSettingsDto(), { defaultSeries: "C" });
    await controller.updateFiscalSettings(req, dto);
    expect(update.mock.calls[0][0].data.fiscalSettings).toMatchObject({ defaultSeries: "C", pricesIncludeTax: true });
  });

  it("a null (which @IsOptional lets through) is not stored", async () => {
    const { controller, req, update } = controllerWith({ pricesIncludeTax: true });
    const dto = Object.assign(new UpdateTenantFiscalSettingsDto(), { pricesIncludeTax: null as any });
    await controller.updateFiscalSettings(req, dto);
    expect(update.mock.calls[0][0].data.fiscalSettings).toEqual({ pricesIncludeTax: true });
  });

  it("can be turned off", async () => {
    const { controller, req, update } = controllerWith({ pricesIncludeTax: true });
    const dto = Object.assign(new UpdateTenantFiscalSettingsDto(), { pricesIncludeTax: false });
    await controller.updateFiscalSettings(req, dto);
    expect(update.mock.calls[0][0].data.fiscalSettings).toEqual({ pricesIncludeTax: false });
  });
});

describe("a new salon", () => {
  it("starts with prices that include the tax, and the column's other defaults", async () => {
    const tenantCreate = jest.fn(async (_args: { data: Record<string, unknown> }) => ({ id: "tenant-new" }));
    const userCreate = jest.fn(async () => ({ id: "user-new", email: "dueña@salon.test", role: "owner" }));
    const tx = { tenant: { create: tenantCreate }, user: { create: userCreate } };
    const prev = process.env.BCRYPT_ROUNDS;
    process.env.BCRYPT_ROUNDS = "4";
    try {
      await createTenantWithOwner(tx as any, {
        name: "Salón Nuevo",
        slug: "salon-nuevo",
        ownerEmail: "dueña@salon.test",
        ownerPassword: "x".repeat(12),
        ownerFirstName: "Ana",
        ownerLastName: "Pérez",
      });
    } finally {
      if (prev === undefined) delete process.env.BCRYPT_ROUNDS;
      else process.env.BCRYPT_ROUNDS = prev;
    }
    const fiscalSettings = tenantCreate.mock.calls[0][0].data.fiscalSettings;
    expect(fiscalSettings).toEqual({
      defaultSeries: "A",
      defaultTaxRate: 21,
      autoInvoiceAppointments: false,
      diputacion: null,
      taxRegime: "iva",
      pricesIncludeTax: true,
    });
    expect(pricesIncludeTaxOf(fiscalSettings)).toBe(true);
    // A copy: a write to one salon's settings never reaches the constant.
    expect(fiscalSettings).not.toBe(NEW_SALON_FISCAL_SETTINGS);
  });

  it("gets the column default's settings plus pricesIncludeTax, so the two do not drift", () => {
    const schema = fs.readFileSync(path.join(__dirname, "..", "..", "prisma", "schema.prisma"), "utf8");
    const match = schema.match(/^\s*fiscalSettings\s+Json\s+@default\("((?:[^"\\]|\\.)*)"\)/m);
    expect(match).not.toBeNull();
    const columnDefault = JSON.parse(JSON.parse(`"${match![1]}"`));
    // The column default itself has no key: existing rows read as tax on top.
    expect(columnDefault).not.toHaveProperty("pricesIncludeTax");
    expect(NEW_SALON_FISCAL_SETTINGS).toEqual({ ...columnDefault, pricesIncludeTax: true });
  });
});
