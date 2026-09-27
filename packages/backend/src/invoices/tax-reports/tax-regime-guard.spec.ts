import { BadRequestException } from "@nestjs/common";
import { TaxReportType } from "@prisma/client";
import { TaxReportsService } from "./tax-reports.service";

/**
 * A quarterly return that does not match the tenant's tax regime must be
 * refused, not approximated.
 *
 * `aggregateModelo303` buckets invoices by rate and then reads only the
 * buckets for 21, 10 and 4 — the IVA rates. A Canarian salon bills IGIC at
 * 7 %, which matches none of them, so every box came out 0 and the report was
 * saved as a valid `draft` with no error. A tax return that is silently wrong
 * is worse than a missing feature, because someone might file it.
 *
 * The Modelo 420 itself is refused too, for the same reason: its box layout
 * comes from the Agencia Tributaria Canaria, and approximating it from the 303
 * would recreate the bug this guard exists to stop.
 */

function serviceFor(fiscalSettings: unknown): {
  service: TaxReportsService;
  prisma: any;
} {
  const prisma: any = {
    tenant: { findUnique: jest.fn().mockResolvedValue({ fiscalSettings }) },
    invoice: { findMany: jest.fn().mockResolvedValue([]) },
    taxReport: {
      upsert: jest.fn().mockResolvedValue({
        id: "r1",
        type: TaxReportType.modelo_303,
        year: 2026,
        quarter: 3,
        totalsJson: {},
        fiscalStatus: "draft",
      }),
    },
  };
  return { service: new TaxReportsService(prisma), prisma };
}

describe("tax regime guard on quarterly returns", () => {
  it("refuses a Modelo 303 for a tenant under IGIC", async () => {
    // The bug: this used to succeed and return a report of zeros.
    const { service, prisma } = serviceFor({ taxRegime: "igic" });

    await expect(
      service.generate("t1", TaxReportType.modelo_303, 2026, 3),
    ).rejects.toThrow(BadRequestException);

    // And it refused before reading a single invoice.
    expect(prisma.invoice.findMany).not.toHaveBeenCalled();
    expect(prisma.taxReport.upsert).not.toHaveBeenCalled();
  });

  it("explains which return applies instead", async () => {
    const { service } = serviceFor({ taxRegime: "igic" });

    await expect(
      service.generate("t1", TaxReportType.modelo_303, 2026, 3),
    ).rejects.toThrow(/IGIC[\s\S]*modelo_420/);
  });

  it("allows a Modelo 303 for a tenant under IVA", async () => {
    const { service, prisma } = serviceFor({ taxRegime: "iva" });

    await service.generate("t1", TaxReportType.modelo_303, 2026, 3);

    expect(prisma.taxReport.upsert).toHaveBeenCalled();
  });

  it("treats a missing regime as IVA, so existing tenants are unaffected", async () => {
    // Every tenant created before this change has no taxRegime key.
    const { service, prisma } = serviceFor({ defaultSeries: "A", defaultTaxRate: 21 });

    await service.generate("t1", TaxReportType.modelo_303, 2026, 3);

    expect(prisma.taxReport.upsert).toHaveBeenCalled();
  });

  it("treats an unrecognised regime as IVA rather than failing", async () => {
    const { service, prisma } = serviceFor({ taxRegime: "klingon" });

    await service.generate("t1", TaxReportType.modelo_303, 2026, 3);

    expect(prisma.taxReport.upsert).toHaveBeenCalled();
  });

  it("refuses the Modelo 420 as not implemented, rather than guessing its boxes", async () => {
    const { service, prisma } = serviceFor({ taxRegime: "igic" });

    await expect(
      service.generate("t1", TaxReportType.modelo_420, 2026, 3),
    ).rejects.toThrow(/Agencia Tributaria Canaria/);

    expect(prisma.taxReport.upsert).not.toHaveBeenCalled();
  });

  it("refuses a Modelo 420 for a tenant under IVA, on regime grounds", async () => {
    const { service } = serviceFor({ taxRegime: "iva" });

    await expect(
      service.generate("t1", TaxReportType.modelo_420, 2026, 3),
    ).rejects.toThrow(/modelo_303, not modelo_420/);
  });

  it("refuses any indirect-tax return under IPSI, which has no form here", async () => {
    const { service } = serviceFor({ taxRegime: "ipsi" });

    await expect(
      service.generate("t1", TaxReportType.modelo_303, 2026, 3),
    ).rejects.toThrow(/city council/);
  });

  it("lets the Modelo 130 through under every regime", async () => {
    // IRPF is not an indirect tax, so the territory's regime is irrelevant.
    for (const regime of ["iva", "igic", "ipsi"]) {
      const { service, prisma } = serviceFor({ taxRegime: regime });

      await service.generate("t1", TaxReportType.modelo_130, 2026, 3);

      expect(prisma.taxReport.upsert).toHaveBeenCalled();
      // The regime is not even looked up for a 130.
      expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
    }
  });

  it("still rejects an impossible quarter before anything else", async () => {
    const { service, prisma } = serviceFor({ taxRegime: "iva" });

    await expect(
      service.generate("t1", TaxReportType.modelo_303, 2026, 7),
    ).rejects.toThrow(/Invalid quarter/);

    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });
});
