/**
 * Tests for the Modelo 303 + 130 draft generator.
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
  const prisma: any = {
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
  return { prisma, invoices, stored, upsertCalls };
}

const sampleInvoice = (cents: number, breakdown: any[]): any => ({
  id: `inv-${Math.random().toString(36).slice(2, 8)}`,
  tenantId: "tenant-1",
  status: "issued",
  issueDate: new Date("2026-04-15"),
  totalCents: cents,
  taxBreakdown: breakdown,
});

describe("TaxReportsService.generate — Modelo 303", () => {
  it("aggregates by tax rate and computes the 7+2 Casillas", async () => {
    const m = makePrisma();
    m.invoices.push(
      sampleInvoice(12100, [{ rate: 21, baseCents: 10000, taxCents: 2100 }]),
      sampleInvoice(12100, [{ rate: 21, baseCents: 10000, taxCents: 2100 }]),
      sampleInvoice(11000, [{ rate: 10, baseCents: 10000, taxCents: 1000 }]),
    );
    const svc = new TaxReportsService(m.prisma);
    const r = await svc.generate("tenant-1", "modelo_303" as any, 2026, 2);
    expect(r.status).toBe("draft");
    expect(r.totalsJson["01"]).toBe(20000); // 21% base
    expect(r.totalsJson["03"]).toBe(4200); // 21% tax
    expect(r.totalsJson["04"]).toBe(10000); // 10% base
    expect(r.totalsJson["06"]).toBe(1000); // 10% tax
    expect(r.totalsJson["36"]).toBe(5200); // devengada total
    expect(r.totalsJson["67"]).toBe(5200); // devengada - deducida(0)
  });

  it("returns zeroes when no invoices in the period", async () => {
    const m = makePrisma();
    const svc = new TaxReportsService(m.prisma);
    const r = await svc.generate("tenant-1", "modelo_303" as any, 2026, 4);
    expect(r.totalsJson["36"]).toBe(0);
    expect(r.totalsJson["67"]).toBe(0);
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

  it("groups 4% rates separately (not lumped with 21% or 10%)", async () => {
    const m = makePrisma();
    m.invoices.push(
      sampleInvoice(1040, [{ rate: 4, baseCents: 1000, taxCents: 40 }]),
    );
    const svc = new TaxReportsService(m.prisma);
    const r = await svc.generate("tenant-1", "modelo_303" as any, 2026, 2);
    expect(r.totalsJson["07"]).toBe(1000);
    expect(r.totalsJson["09"]).toBe(40);
    expect(r.totalsJson["01"]).toBe(0);
    expect(r.totalsJson["04"]).toBe(0);
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
