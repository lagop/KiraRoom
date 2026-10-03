/**
 * Tests for the Modelo 303 + 130 draft generator (the 303 box layout itself
 * is pinned in modelo-303.spec.ts).
 *
 * Uses an in-memory Prisma mock so no DB is needed. The cron submission
 * path (TaxReportsDispatchService) is intentionally NOT in v1 — see the
 * final roadmap note about Modelo 303 needing legal review.
 */

import { TaxReportsService } from "./tax-reports.service";

function makePrisma() {
  const stored: any[] = [];
  const invoices: any[] = [];
  const upsertCalls: any[] = [];
  // The tenant's tax regime decides which quarterly return is allowed:
  // `generate` refuses a Modelo 303 for an IGIC tenant, because that
  // aggregator only reads the IVA rate buckets and would report zeros. These
  // cases all exercise the 303 with 21/10/4, so the tenant is under IVA.
  // Mutate `fiscalSettings` in a test to check another regime.
  const fiscalSettings: Record<string, unknown> = { taxRegime: "iva" };
  const prisma: any = {
    tenant: {
      findUnique: async () => ({ fiscalSettings }),
    },
    invoice: {
      findMany: async (args: any) => {
        const where = args?.where?.issueDate ?? {};
        const start = where.gte;
        const end = where.lte;
        return invoices.filter((inv) => {
          if (start && inv.issueDate < start) return false;
          if (end && inv.issueDate > end) return false;
          return true;
        });
      },
    },
    taxReport: {
      upsert: async (args: any) => {
        upsertCalls.push(args);
        const where = args.where.tenantId_type_year_quarter;
        const idx = stored.findIndex(
          (r) =>
            r.tenantId === where.tenantId &&
            r.type === where.type &&
            r.year === where.year &&
            r.quarter === where.quarter,
        );
        const merged = idx >= 0 ? { ...stored[idx], ...args.update } : { ...args.create };
        if (idx >= 0) stored[idx] = merged;
        else stored.push(merged);
        return merged;
      },
      findUnique: async (args: any) => {
        const where = args.where.tenantId_type_year_quarter;
        return (
          stored.find(
            (r) =>
              r.tenantId === where.tenantId &&
              r.type === where.type &&
              r.year === where.year &&
              r.quarter === where.quarter,
          ) ?? null
        );
      },
      findMany: async (args: any) => {
        const list = args?.where?.tenantId
          ? stored.filter((r) => r.tenantId === args.where.tenantId)
          : stored;
        return list
          .sort((a, b) => b.year - a.year || b.quarter - a.quarter)
          .slice(0, args?.take ?? 50);
      },
    },
  };
  return { prisma, invoices, stored, upsertCalls, fiscalSettings };
}

const sampleInvoice = (cents: number, breakdown: any[], series = "A"): any => ({
  id: `inv-${Math.random().toString(36).slice(2, 8)}`,
  tenantId: "tenant-1",
  series,
  status: "issued",
  issueDate: new Date("2026-04-15"),
  totalCents: cents,
  taxBreakdown: breakdown,
});

describe("TaxReportsService.generate — Modelo 303", () => {
  // Box numbers from the AEAT's 2026 instructions (see modelo-303.ts):
  // 4 % -> 01-03, 10 % -> 04-06, 21 % -> 07-09, 27 devengado, 45 a deducir,
  // 46 = 27 - 45, 71 resultado de la liquidación.
  it("puts each rate in its AEAT row and computes 27, 46 and 71", async () => {
    const m = makePrisma();
    m.invoices.push(
      sampleInvoice(12100, [{ rate: 21, baseCents: 10000, taxCents: 2100 }]),
      sampleInvoice(12100, [{ rate: 21, baseCents: 10000, taxCents: 2100 }]),
      sampleInvoice(11000, [{ rate: 10, baseCents: 10000, taxCents: 1000 }]),
    );
    const svc = new TaxReportsService(m.prisma);
    const r = await svc.generate("tenant-1", "modelo_303" as any, 2026, 2);
    expect(r.status).toBe("draft");
    expect(r.totalsJson["07"]).toBe(20000); // 21% base
    expect(r.totalsJson["08"]).toBe(21); // 21% tipo
    expect(r.totalsJson["09"]).toBe(4200); // 21% cuota
    expect(r.totalsJson["04"]).toBe(10000); // 10% base
    expect(r.totalsJson["06"]).toBe(1000); // 10% cuota
    expect(r.totalsJson["01"]).toBe(0); // 4% base
    expect(r.totalsJson["27"]).toBe(5200); // total cuota devengada
    expect(r.totalsJson["45"]).toBe(0); // total a deducir: no purchases in KiraRoom
    expect(r.totalsJson["46"]).toBe(5200); // 27 - 45
    expect(r.totalsJson["71"]).toBe(5200); // resultado de la liquidación
  });

  it("returns zeroes when no invoices in the period", async () => {
    const m = makePrisma();
    const svc = new TaxReportsService(m.prisma);
    const r = await svc.generate("tenant-1", "modelo_303" as any, 2026, 4);
    expect(r.totalsJson["27"]).toBe(0);
    expect(r.totalsJson["46"]).toBe(0);
    expect(r.totalsJson["71"]).toBe(0);
  });

  it("rejects an invalid quarter", async () => {
    const m = makePrisma();
    const svc = new TaxReportsService(m.prisma);
    await expect(
      svc.generate("tenant-1", "modelo_303" as any, 2026, 5),
    ).rejects.toThrow(/Invalid quarter/);
  });

  it("is idempotent — re-running overwrites the existing row", async () => {
    const m = makePrisma();
    const svc = new TaxReportsService(m.prisma);
    m.invoices.push(
      sampleInvoice(12100, [{ rate: 21, baseCents: 10000, taxCents: 2100 }]),
    );
    const r1 = await svc.generate("tenant-1", "modelo_303" as any, 2026, 1);
    m.invoices.push(
      sampleInvoice(12100, [{ rate: 21, baseCents: 10000, taxCents: 2100 }]),
    );
    const r2 = await svc.generate("tenant-1", "modelo_303" as any, 2026, 1);
    expect(r1.id).toBe(r2.id);
    expect(m.stored.length).toBe(1);
    expect(m.upsertCalls.length).toBe(2);
  });

  it("puts 4 % in 01-03 (not lumped with 21 % or 10 %)", async () => {
    const m = makePrisma();
    m.invoices.push(
      sampleInvoice(1040, [{ rate: 4, baseCents: 1000, taxCents: 40 }]),
    );
    const svc = new TaxReportsService(m.prisma);
    const r = await svc.generate("tenant-1", "modelo_303" as any, 2026, 2);
    expect(r.totalsJson["01"]).toBe(1000);
    expect(r.totalsJson["03"]).toBe(40);
    expect(r.totalsJson["07"]).toBe(0);
    expect(r.totalsJson["04"]).toBe(0);
  });

  it("puts a rectifying invoice (series R) in 14-15, not in its rate's row", async () => {
    const m = makePrisma();
    m.invoices.push(
      sampleInvoice(12100, [{ rate: 21, baseCents: 10000, taxCents: 2100 }]),
      sampleInvoice(-2420, [{ rate: 21, baseCents: -2000, taxCents: -420 }], "R"),
    );
    const svc = new TaxReportsService(m.prisma);
    const r = await svc.generate("tenant-1", "modelo_303" as any, 2026, 2);
    expect(r.totalsJson["07"]).toBe(10000);
    expect(r.totalsJson["14"]).toBe(-2000);
    expect(r.totalsJson["15"]).toBe(-420);
    expect(r.totalsJson["27"]).toBe(1680);
  });

  it("refuses a rate the 303 has no row for instead of dropping it", async () => {
    const m = makePrisma();
    m.invoices.push(sampleInvoice(1050, [{ rate: 5, baseCents: 1000, taxCents: 50 }]));
    const svc = new TaxReportsService(m.prisma);
    await expect(svc.generate("tenant-1", "modelo_303" as any, 2026, 2)).rejects.toThrow(/5 %/);
    expect(m.upsertCalls.length).toBe(0);
  });
});

describe("TaxReportsService.generate — Modelo 130", () => {
  it("computes 20% flat over total invoiced (MVP)", async () => {
    const m = makePrisma();
    m.invoices.push(
      sampleInvoice(12100, [{ rate: 21, baseCents: 10000, taxCents: 2100 }]),
    );
    const svc = new TaxReportsService(m.prisma);
    const r = await svc.generate("tenant-1", "modelo_130" as any, 2026, 2);
    expect(r.totalsJson["01"]).toBe(12100); // ingresos
    expect(r.totalsJson["02"]).toBe(2420); // rendimiento 20%
    expect(r.totalsJson["03"]).toBe(0); // retenciones
    expect(r.totalsJson["18"]).toBe(2420); // cuota diferencial
  });

  it("returns zeroes when no invoices in the period", async () => {
    const m = makePrisma();
    const svc = new TaxReportsService(m.prisma);
    const r = await svc.generate("tenant-1", "modelo_130" as any, 2026, 4);
    expect(r.totalsJson["01"]).toBe(0);
    expect(r.totalsJson["18"]).toBe(0);
  });
});

describe("TaxReportsService.quarterRange", () => {
  it("returns the right calendar boundaries for Q1", () => {
    const { start, end } = TaxReportsService.quarterRange(2026, 1);
    expect(start.toISOString().slice(0, 10)).toBe("2026-01-01");
    expect(end.toISOString().slice(0, 10)).toBe("2026-03-31");
  });

  it("returns the right calendar boundaries for Q4", () => {
    const { start, end } = TaxReportsService.quarterRange(2026, 4);
    expect(start.toISOString().slice(0, 10)).toBe("2026-10-01");
    expect(end.toISOString().slice(0, 10)).toBe("2026-12-31");
  });

  it("handles a leap year correctly", () => {
    const { start, end } = TaxReportsService.quarterRange(2024, 1);
    expect(end.toISOString().slice(0, 10)).toBe("2024-03-31");
  });
});

describe("TaxReportsService.find / listForTenant", () => {
  it("find returns null when no report exists", async () => {
    const m = makePrisma();
    const svc = new TaxReportsService(m.prisma);
    expect(
      await svc.find("tenant-1", "modelo_303" as any, 2026, 1),
    ).toBeNull();
  });

  it("listForTenant returns newest first", async () => {
    const m = makePrisma();
    const svc = new TaxReportsService(m.prisma);
    await svc.generate("tenant-1", "modelo_303" as any, 2026, 1);
    await svc.generate("tenant-1", "modelo_303" as any, 2026, 4);
    await svc.generate("tenant-1", "modelo_130" as any, 2026, 2);
    const list = await svc.listForTenant("tenant-1");
    expect(list.map((r) => `${r.type}:${r.year}Q${r.quarter}`)).toEqual([
      "modelo_303:2026Q4",
      "modelo_130:2026Q2",
      "modelo_303:2026Q1",
    ]);
  });
});
