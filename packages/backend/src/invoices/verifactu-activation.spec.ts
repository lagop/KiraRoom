import { InvoicesController } from "./invoices.controller";

/** PATCH /invoices/settings/fiscal: when the fiscal mode may change. */
function setup(row: Record<string, unknown> = {}, counts: { certificates?: number; records?: number } = {}) {
  const stored: Record<string, unknown> = {
    fiscalMode: "none",
    fiscalSettings: { defaultSeries: "A" },
    taxId: "B12345674",
    taxIdType: "cif",
    legalName: "Peluquería Ejemplo S.L.",
    timezone: "Europe/Madrid",
    ...row,
  };
  const prisma = {
    tenant: {
      findUnique: jest.fn(async () => ({ ...stored })),
      update: jest.fn(async (args: { data: Record<string, unknown> }) => Object.assign(stored, args.data)),
    },
    fiscalCertificate: { count: jest.fn(async () => counts.certificates ?? 0) },
    verifactuRecord: { count: jest.fn(async () => counts.records ?? 0) },
    verifactuChain: { upsert: jest.fn(async () => ({})) },
  };
  const auditLog = { record: jest.fn(async () => undefined) };
  const controller = new InvoicesController({} as any, {} as any, {} as any, prisma as any, {} as any, auditLog as any);
  const req = { user: { tenantId: "tenant-1", id: "user-1", role: "owner" } } as any;
  return { controller, req, prisma, auditLog, stored };
}

describe("switching the fiscal mode", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  const production = (flag?: string) => {
    (process.env as Record<string, string | undefined>).NODE_ENV = "production";
    if (flag) process.env.FISCAL_SUBMISSION_ENABLED = flag;
    else delete process.env.FISCAL_SUBMISSION_ENABLED;
  };

  it("with the flag off in production, nothing can be switched on and nothing is written", async () => {
    production();
    for (const fiscalMode of ["verifactu", "ticketbai", "sii_only"]) {
      const { controller, req, prisma } = setup({}, { certificates: 1 });
      await expect(controller.updateFiscalSettings(req, { fiscalMode } as any)).rejects.toThrow(/todavía no está disponible/);
      expect(prisma.tenant.update).not.toHaveBeenCalled();
      expect(prisma.verifactuChain.upsert).not.toHaveBeenCalled();
    }
  });

  it("the flag opens VERI*FACTU, never the TicketBAI and SII stubs", async () => {
    production("1");
    for (const fiscalMode of ["ticketbai", "sii_only"]) {
      const { controller, req } = setup();
      await expect(controller.updateFiscalSettings(req, { fiscalMode } as any)).rejects.toThrow(/todavía no está disponible/);
    }
    const { controller, req, prisma, auditLog, stored } = setup({}, { certificates: 1 });
    await controller.updateFiscalSettings(req, { fiscalMode: "verifactu" } as any);
    expect(stored.fiscalMode).toBe("verifactu");
    expect(prisma.verifactuChain.upsert).toHaveBeenCalledTimes(1);
    expect(auditLog.record).toHaveBeenCalledWith(
      "tenant.fiscalMode.change",
      expect.objectContaining({ tenantId: "tenant-1", metadata: { before: "none", after: "verifactu" } }),
    );
  });

  it("activating needs a NIF and a certificate", async () => {
    production("1");
    delete process.env.VERIFACTU_PLATFORM_P12;
    const noCert = setup();
    await expect(noCert.controller.updateFiscalSettings(noCert.req, { fiscalMode: "verifactu" } as any)).rejects.toThrow(/certificado/);
    expect(noCert.prisma.tenant.update).not.toHaveBeenCalled();
  });

  it("once it has records this year it stays on until 31 December; with none it can go off", async () => {
    production("1");
    const on = setup({ fiscalMode: "verifactu" }, { records: 3 });
    await expect(on.controller.updateFiscalSettings(on.req, { fiscalMode: "none" } as any)).rejects.toThrow(/31 de diciembre/);
    const unused = setup({ fiscalMode: "verifactu" }, { records: 0 });
    await unused.controller.updateFiscalSettings(unused.req, { fiscalMode: "none" } as any);
    expect(unused.stored.fiscalMode).toBe("none");
  });
});
