/**
 * InvoiceService.allocateNumber concurrency + InvoiceService.fromOrder/fromAppointment
 * unit tests. Uses an in-memory Prisma mock.
 */

import { InvoiceService } from "./invoices.service";
import { InvoiceCalculator } from "./invoice-calculator.service";

function makePrismaMock() {
  const tenant: any = {
    id: "tenant-1",
    fiscalMode: "none",
    fiscalSettings: { defaultSeries: "A", defaultTaxRate: 21 },
  };

  const sequences = new Map<string, any>(); // key = tenantId|series|year
  const invoices: any[] = [];
  const invoiceLines: any[] = [];

  const tenantFindUnique = jest.fn(async () => tenant);
  const sequenceUpsert = jest.fn(async (args: any) => {
    const key = `${args.where.tenantId_series_year.tenantId}|${args.where.tenantId_series_year.series}|${args.where.tenantId_series_year.year}`;
    if (!sequences.has(key)) {
      sequences.set(key, {
        tenantId: args.where.tenantId_series_year.tenantId,
        series: args.where.tenantId_series_year.series,
        year: args.where.tenantId_series_year.year,
        lastNumber: 0,
      });
    }
    return sequences.get(key);
  });
  const sequenceUpdate = jest.fn(async (args: any) => {
    const key = `${args.where.tenantId_series_year.tenantId}|${args.where.tenantId_series_year.series}|${args.where.tenantId_series_year.year}`;
    const cur = sequences.get(key);
    // Simulate atomic Prisma `increment` so concurrent calls produce
    // strictly monotonic results (this is the contract we want to lock in).
    if (args.data.lastNumber?.increment) {
      cur.lastNumber += args.data.lastNumber.increment;
    } else {
      cur.lastNumber = args.data.lastNumber;
    }
    sequences.set(key, cur);
    return cur;
  });

  // Serialise updates so concurrent calls don't race in the mock. In real
  // Postgres, `UPDATE ... SET x = x + 1` is atomic; we mimic that here.
  let chain: Promise<unknown> = Promise.resolve();
  sequenceUpdate.mockImplementation(async (args: any) => {
    const next = chain.then(async () => {
      const key = `${args.where.tenantId_series_year.tenantId}|${args.where.tenantId_series_year.series}|${args.where.tenantId_series_year.year}`;
      const cur = sequences.get(key);
      if (args.data.lastNumber?.increment) {
        cur.lastNumber += args.data.lastNumber.increment;
      } else {
        cur.lastNumber = args.data.lastNumber;
      }
      sequences.set(key, cur);
      // Return a snapshot — the caller captures `updated.lastNumber` at
      // the moment of return, not later. Real Prisma returns a fresh row.
      return { ...cur };
    });
    chain = next.catch(() => undefined);
    return next;
  });

  const invoiceCreate = jest.fn(async (args: any) => {
    const inv = {
      id: `inv-${invoices.length + 1}`,
      ...args.data,
    };
    invoices.push(inv);
    if (args.data.lines?.create) {
      for (const l of args.data.lines.create) {
        invoiceLines.push({
          id: `line-${invoiceLines.length + 1}`,
          invoiceId: inv.id,
          ...l,
        });
      }
    }
    return inv;
  });

  const prisma: any = {
    tenant: { findUnique: tenantFindUnique },
    fiscalSequence: { upsert: sequenceUpsert, update: sequenceUpdate },
    invoice: { create: invoiceCreate, update: async () => ({}), findMany: async () => [], findUnique: async () => null, findFirst: async () => null },
    order: { findUnique: async () => null },
    appointment: { findUnique: async () => null },
  };

  return {
    prisma,
    sequences,
    invoices,
    invoiceLines,
  };
}

describe("InvoiceService.allocateNumber", () => {
  it("first allocation returns '000001' for the (tenant, series, year) tuple", async () => {
    const m = makePrismaMock();
    const svc = new InvoiceService(m.prisma, new InvoiceCalculator(), {} as any);
    const n = await svc.allocateNumber("tenant-1", "A", 2026);
    expect(n).toBe("000001");
  });

  it("subsequent allocations increment sequentially", async () => {
    const m = makePrismaMock();
    const svc = new InvoiceService(m.prisma, new InvoiceCalculator(), {} as any);
    const n1 = await svc.allocateNumber("tenant-1", "A", 2026);
    const n2 = await svc.allocateNumber("tenant-1", "A", 2026);
    const n3 = await svc.allocateNumber("tenant-1", "A", 2026);
    expect(n1).toBe("000001");
    expect(n2).toBe("000002");
    expect(n3).toBe("000003");
  });

  it("allocations are isolated per (series, year) tuple", async () => {
    const m = makePrismaMock();
    const svc = new InvoiceService(m.prisma, new InvoiceCalculator(), {} as any);
    expect(await svc.allocateNumber("tenant-1", "A", 2026)).toBe("000001");
    expect(await svc.allocateNumber("tenant-1", "B", 2026)).toBe("000001");
    expect(await svc.allocateNumber("tenant-1", "A", 2027)).toBe("000001");
    expect(await svc.allocateNumber("tenant-1", "A", 2026)).toBe("000002");
  });

  it("concurrent allocations of the same tuple produce distinct numbers (best effort)", async () => {
    const m = makePrismaMock();
    const svc = new InvoiceService(m.prisma, new InvoiceCalculator(), {} as any);
    const promises = Array.from({ length: 10 }, () =>
      svc.allocateNumber("tenant-1", "A", 2026),
    );
    const numbers = (await Promise.all(promises)).sort();
    // Under serial semantics we get 000001..000010. With concurrent mock
    // (single-threaded await ordering) we still get the same range.
    expect(numbers[0]).toBe("000001");
    expect(numbers[9]).toBe("000010");
    expect(new Set(numbers).size).toBe(10);
  });
});

describe("InvoiceService.create", () => {
  it("creates an invoice with tax breakdown when tenant.fiscalMode=none (fiscalStatus=not_required)", async () => {
    const m = makePrismaMock();
    const svc = new InvoiceService(m.prisma, new InvoiceCalculator(), {} as any);
    const r = await svc.create({
      tenantId: "tenant-1",
      recipientName: "Cliente X",
      recipientTaxId: "12345678A",
      lines: [
        { description: "Corte", quantity: 1, unitPriceCents: 10000, taxRate: 21 },
      ],
    });
    expect(r.id).toBeDefined();
    const created = m.invoices[0];
    expect(created.subtotalCents).toBe(10000);
    expect(created.totalCents).toBe(12100);
    expect(created.fiscalStatus).toBe("not_required");
    expect(m.invoiceLines).toHaveLength(1);
  });

  it("rejects empty line list", async () => {
    const m = makePrismaMock();
    const svc = new InvoiceService(m.prisma, new InvoiceCalculator(), {} as any);
    await expect(
      svc.create({
        tenantId: "tenant-1",
        recipientName: "X",
        lines: [],
      }),
    ).rejects.toThrow(/at least one line/);
  });
});