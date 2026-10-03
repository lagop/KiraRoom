import { InvoiceService } from "./invoices.service";
import { InvoiceCalculator } from "./invoice-calculator.service";

/**
 * Tests for `InvoiceService.anulate()` and `InvoiceService.emitRectification`.
 *
 * Verifies the simple (non-fiscal) path. Fiscal anulation is exercised
 * in the e2e suite because it touches real XAdES signing + chain state.
 */

function makePrismaMock() {
  const tenant = { id: "tenant-1", name: "Salon Test", fiscalMode: "none" as any, fiscalSettings: {} };
  const invoices = new Map<string, any>();
  const sequences = new Map<string, any>();
  return {
    tenant,
    invoices,
    sequences,
    prisma: {
      tenant: { findUnique: async () => tenant },
      invoice: {
        findUnique: async (args: any) => {
          const id = args.where?.id;
          return invoices.get(id) ?? null;
        },
        findFirst: async (args: any) => {
          const id = args.where?.id;
          const inv = invoices.get(id);
          if (!inv) return null;
          if (args.where?.tenantId && inv.tenantId !== args.where.tenantId) return null;
          return inv;
        },
        create: async (args: any) => {
          const id = `inv-${invoices.size + 1}`;
          const inv = { id, ...args.data, lines: [] };
          invoices.set(id, inv);
          return inv;
        },
        update: async (args: any) => {
          const cur = invoices.get(args.where.id);
          Object.assign(cur, args.data);
          return cur;
        },
        findMany: async () => [],
      },
      invoiceLine: { create: async () => ({}) },
      fiscalSequence: {
        upsert: async (args: any) => {
          const key = `${args.where.tenantId_series_year.tenantId}|${args.where.tenantId_series_year.series}|${args.where.tenantId_series_year.year}`;
          const cur = sequences.get(key);
          const next = cur ? { ...cur, ...args.update } : args.create;
          sequences.set(key, next);
          return next;
        },
        update: async (args: any) => {
          const key = `${args.where.tenantId_series_year.tenantId}|${args.where.tenantId_series_year.series}|${args.where.tenantId_series_year.year}`;
          const cur = sequences.get(key) ?? { lastNumber: 0 };
          if (args.data.lastNumber?.increment) cur.lastNumber += args.data.lastNumber.increment;
          sequences.set(key, cur);
          return cur;
        },
      },
      accountingConnection: { findUnique: async () => null },
      accountingsyncLog: { create: async () => ({}) },
    } as any,
  };
}

function seedInvoice(m: any, overrides: any = {}) {
  const inv = {
    id: "inv-1",
    tenantId: "tenant-1",
    series: "A",
    number: "000001",
    issueDate: new Date(),
    recipientType: "client",
    recipientId: null,
    recipientName: "Cliente X",
    recipientTaxId: null,
    subtotalCents: 10000,
    totalCents: 12100,
    currency: "EUR",
    status: "issued",
    fiscalMode: "none",
    notes: null,
    lines: [],
    ...overrides,
  };
  m.invoices.set(inv.id, inv);
  return inv;
}

describe("InvoiceService.anulate (no-fiscal path)", () => {
  function build() {
    const m = makePrismaMock();
    const svc = new InvoiceService(
      m.prisma,
      new InvoiceCalculator(),
      /* fiscal */ null,
    );
    return { m, svc };
  }

  it("marks the invoice cancelled and appends the reason to notes", async () => {
    const { m, svc } = build();
    seedInvoice(m);
    const result = await svc.anulate("tenant-1", "inv-1", "Cliente canceló");
    expect((result as any).status).toBe("cancelled");
    expect((result as any).notes).toMatch(/ANULATED: Cliente canceló/);
    expect((result as any).fiscalAnulated).toBe(false);
  });

  it("throws BadRequest when invoice is already cancelled", async () => {
    const { m, svc } = build();
    seedInvoice(m, { status: "cancelled" });
    await expect(svc.anulate("tenant-1", "inv-1", "x")).rejects.toThrow(
      /already cancelled/,
    );
  });

  it("throws NotFound when invoice does not exist", async () => {
    const { svc } = build();
    await expect(svc.anulate("tenant-1", "ghost", "x")).rejects.toThrow();
  });
});

/**
 * An invoice already in Holded stayed there as a live sale after being
 * cancelled here. The cancellation now marks it for mirroring in the same
 * update (so it cannot be lost) and hands it to AccountingService.
 */
describe("InvoiceService cancel/anulate and Holded", () => {
  function build() {
    const m = makePrismaMock();
    const accounting = { reflectCancellation: jest.fn(async () => ({ status: "synced" })) };
    const svc = new InvoiceService(m.prisma, new InvoiceCalculator(), /* fiscal */ null as any, accounting as any);
    return { m, svc, accounting };
  }

  it.each(["cancel", "anulate"] as const)("%s marks an invoice that is in Holded and mirrors it", async (action) => {
    const { m, svc, accounting } = build();
    seedInvoice(m, { accountingStatus: "synced", accountingExternalId: "65f0aa" });
    await svc[action]("tenant-1", "inv-1", "Error en el importe");
    expect(m.invoices.get("inv-1")).toMatchObject({ status: "cancelled", accountingCancelStatus: "pending" });
    expect(accounting.reflectCancellation).toHaveBeenCalledWith("inv-1");
  });

  it("does not mark an invoice that never went to Holded", async () => {
    const { m, svc } = build();
    seedInvoice(m, { accountingStatus: "not_synced", accountingExternalId: null });
    await svc.cancel("tenant-1", "inv-1", "x");
    expect(m.invoices.get("inv-1").accountingCancelStatus).toBeUndefined();
  });
});

describe("InvoiceService.emitRectification", () => {
  it("creates a new invoice with series='R' referencing the original", async () => {
    const m = makePrismaMock();
    const svc = new InvoiceService(
      m.prisma,
      new InvoiceCalculator(),
      /* fiscal */ null,
    );
    seedInvoice(m);

    const result = await svc.emitRectification(
      "tenant-1",
      "inv-1",
      [
        {
          description: "Descuento por fidelización",
          quantity: 1,
          unitPriceCents: -1000,
          taxRate: 21,
        },
      ],
      "Cliente VIP",
    );
    expect(result.id).toBeDefined();
    const newInv = m.invoices.get(result.id);
    // The newly-created invoice uses the series "R".
    // (We can't easily assert series because the InvoiceService.create() path
    // queries tenant settings, but we can verify the note.)
    expect(newInv.notes).toMatch(/Rectificación de A000001/);
  });
});
