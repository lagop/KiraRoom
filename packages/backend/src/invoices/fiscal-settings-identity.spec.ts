import { BadRequestException } from "@nestjs/common";
import { InvoicesController } from "./invoices.controller";
import { UpdateTenantFiscalSettingsDto } from "./dto/invoice.dto";
import { fiscalSettingsView, LEGAL_NAME_REQUIRED, TAX_ID_REQUIRED } from "./fiscal-identity";

/**
 * Ajustes > Fiscal loads its form from GET /invoices/settings/fiscal and
 * saves it with PATCH. GET used to return only fiscalMode and
 * fiscalSettings, so the razón social and the ID type loaded empty and every
 * save wrote them back empty.
 */

type Row = {
  fiscalMode: string;
  fiscalSettings: Record<string, unknown>;
  taxId: string | null;
  taxIdType: string | null;
  legalName: string | null;
};

function setup(row: Partial<Row> = {}) {
  const stored: Row = {
    fiscalMode: "none",
    fiscalSettings: { defaultSeries: "A", defaultTaxRate: 21, tenantNif: "B12345674" },
    taxId: "B12345674",
    taxIdType: "cif",
    legalName: "Peluquería Ejemplo S.L.",
    ...row,
  };
  const findUnique = jest.fn(async () => stored);
  const update = jest.fn(async (args: { data: Record<string, unknown> }) => {
    const { fiscalMode, ...rest } = args.data;
    Object.assign(stored, rest, fiscalMode ? { fiscalMode } : {});
    return stored;
  });
  const prisma = { tenant: { findUnique, update } };
  const controller = new InvoicesController({} as any, {} as any, {} as any, prisma as any, {} as any);
  const req = { user: { tenantId: "tenant-1" } } as any;
  const dto = (fields: Record<string, unknown>) =>
    Object.assign(new UpdateTenantFiscalSettingsDto(), fields);
  return { controller, req, dto, findUnique, update, stored };
}

describe("GET /invoices/settings/fiscal", () => {
  it("returns the NIF, its type and the razón social with the settings", async () => {
    const { controller, req, findUnique } = setup();
    const res = await controller.getFiscalSettings(req);
    expect(res).toMatchObject({
      fiscalMode: "none",
      fiscalSettings: { defaultSeries: "A", defaultTaxRate: 21 },
      taxId: "B12345674",
      taxIdType: "cif",
      legalName: "Peluquería Ejemplo S.L.",
    });
    expect(typeof res.submissionAvailable).toBe("boolean");
    const select = (findUnique.mock.calls[0] as any)[0].select;
    expect(select).toMatchObject({ taxId: true, taxIdType: true, legalName: true });
  });

  it("the NIF column is the source; the settings mirror only fills an empty column", () => {
    const base = { fiscalMode: "none", taxIdType: null, legalName: null };
    expect(
      fiscalSettingsView({ ...base, taxId: "B12345674", fiscalSettings: { tenantNif: "OLD" } }).taxId,
    ).toBe("B12345674");
    expect(fiscalSettingsView({ ...base, taxId: null, fiscalSettings: { tenantNif: "12345678Z" } }).taxId).toBe(
      "12345678Z",
    );
    expect(fiscalSettingsView({ ...base, taxId: null, fiscalSettings: { tenantNif: "" } }).taxId).toBeNull();
    expect(fiscalSettingsView(null)).toMatchObject({ fiscalMode: "none", taxId: null, legalName: null });
  });
});

describe("PATCH /invoices/settings/fiscal: the issuer identity", () => {
  it("a save that does not send the razón social, NIF or type leaves them as they were", async () => {
    const { controller, req, dto, update, stored } = setup();
    const res = await controller.updateFiscalSettings(req, dto({ defaultSeries: "B" }));
    const data = update.mock.calls[0][0].data;
    expect(data).not.toHaveProperty("legalName");
    expect(data).not.toHaveProperty("taxId");
    expect(data).not.toHaveProperty("taxIdType");
    expect(stored.legalName).toBe("Peluquería Ejemplo S.L.");
    expect(stored.taxIdType).toBe("cif");
    // The answer has the same shape as GET.
    expect(res).toMatchObject({ legalName: "Peluquería Ejemplo S.L.", taxId: "B12345674", taxIdType: "cif" });
  });

  it.each([[""], ["   "], [null]])("refuses a razón social sent as %p, and saves nothing", async (legalName) => {
    const { controller, req, dto, update, stored } = setup();
    const err = await controller
      .updateFiscalSettings(req, dto({ legalName, defaultSeries: "B" }))
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestException);
    expect((err as BadRequestException).message).toBe(LEGAL_NAME_REQUIRED);
    expect(update).not.toHaveBeenCalled();
    expect(stored.legalName).toBe("Peluquería Ejemplo S.L.");
  });

  it.each([[""], [" "], [null]])("refuses a NIF sent as %p", async (tenantNif) => {
    const { controller, req, dto, update } = setup();
    await expect(controller.updateFiscalSettings(req, dto({ tenantNif }))).rejects.toThrow(TAX_ID_REQUIRED);
    expect(update).not.toHaveBeenCalled();
  });

  it("a new razón social is saved trimmed", async () => {
    const { controller, req, dto, update } = setup();
    await controller.updateFiscalSettings(req, dto({ legalName: "  Nueva Razón S.L. " }));
    expect(update.mock.calls[0][0].data.legalName).toBe("Nueva Razón S.L.");
  });

  it("a new NIF goes to the column and to the settings mirror alike", async () => {
    const { controller, req, dto, update } = setup();
    await controller.updateFiscalSettings(req, dto({ tenantNif: " 12345678z ", taxIdType: "nif" }));
    const data = update.mock.calls[0][0].data as any;
    expect(data.taxId).toBe("12345678Z");
    expect(data.fiscalSettings.tenantNif).toBe("12345678Z");
    expect(data.taxIdType).toBe("nif");
  });

  it("a null ID type leaves the stored one", async () => {
    const { controller, req, dto, update } = setup();
    await controller.updateFiscalSettings(req, dto({ taxIdType: null }));
    expect(update.mock.calls[0][0].data).not.toHaveProperty("taxIdType");
  });
});
