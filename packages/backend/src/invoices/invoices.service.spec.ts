/**
 * InvoiceService.allocateNumber concurrency + InvoiceService.fromOrder/fromAppointment
 * unit tests. Uses an in-memory Prisma mock.
 */

import { Prisma } from "@prisma/client";
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
    // The unique key (tenantId, sourceType, sourceId), as Postgres enforces it.
    const d = args.data;
    if (
      d.sourceId != null &&
      invoices.some((i) => i.tenantId === d.tenantId && i.sourceType === d.sourceType && i.sourceId === d.sourceId)
    ) {
      throw new Prisma.PrismaClientKnownRequestError(
        "Unique constraint failed on the fields: (`tenantId`,`sourceType`,`sourceId`)",
        { code: "P2002", clientVersion: "5.22.0", meta: { target: ["tenantId", "sourceType", "sourceId"] } },
      );
    }
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
    invoice: {
      create: invoiceCreate,
      update: async () => ({}),
      findMany: async () => [],
      findUnique: async () => null,
      findFirst: jest.fn(async (args: any) => {
        const w = args?.where ?? {};
        const row = invoices.find((i) => Object.keys(w).every((k) => i[k] === w[k]));
        if (!row || !args?.select) return row ?? null;
        return Object.fromEntries(Object.keys(args.select).map((k) => [k, row[k]]));
      }),
    },
    order: { findUnique: async () => null },
    appointment: { findUnique: jest.fn(async () => null as any) },
  };

  // Invoice number and invoice are created in one transaction. Like Postgres,
  // transactions on the same counter run one after another (row lock), and
  // one that throws leaves the counter as it found it.
  let txChain: Promise<unknown> = Promise.resolve();
  prisma.$transaction = jest.fn((fn: any) => {
    const run = txChain.then(async () => {
      const before = new Map([...sequences].map(([k, v]) => [k, { ...v }]));
      try {
        return await fn(prisma);
      } catch (err) {
        sequences.clear();
        before.forEach((v, k) => sequences.set(k, v));
        throw err;
      }
    });
    txChain = run.catch(() => undefined);
    return run;
  });

  return {
    prisma,
    invoiceCreate,
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
describe("InvoiceService.fromAppointment", () => {
  function setup(overrides: Record<string, unknown> = {}, fiscalSettings: Record<string, unknown> = {}) {
    const m = makePrismaMock();
    const appointment = {
      id: "appt-1",
      tenantId: "tenant-1",
      status: "completed",
      price: new Prisma.Decimal("30.00"),
      serviceId: "svc-1",
      service: { name: "Corte" },
      client: { id: "client-1", firstName: "Ana", lastName: "López" },
      tenant: { fiscalSettings: { autoInvoiceAppointments: true, defaultTaxRate: 21, ...fiscalSettings } },
      ...overrides,
    };
    m.prisma.appointment.findUnique.mockImplementation(async () => appointment);
    const svc = new InvoiceService(m.prisma, new InvoiceCalculator(), {} as any);
    const lastNumber = () => [...m.sequences.values()][0]?.lastNumber ?? 0;
    return { m, svc, lastNumber };
  }

  it("issues one invoice linked to the appointment; a salon without the setting keeps 21 % on top", async () => {
    const { m, svc } = setup();
    const r = await svc.fromAppointment("appt-1");
    expect(r).toEqual({ id: "inv-1" });
    const inv = m.invoices[0];
    expect(inv.sourceType).toBe("appointment");
    expect(inv.sourceId).toBe("appt-1");
    expect(inv.subtotalCents).toBe(3000);
    expect(inv.totalCents).toBe(3630);
    expect(inv.recipientName).toBe("Ana López");
  });

  it("a second call returns the same invoice and uses no number", async () => {
    const { m, svc, lastNumber } = setup();
    const first = await svc.fromAppointment("appt-1");
    const second = await svc.fromAppointment("appt-1");
    expect(second).toEqual(first);
    expect(m.invoices).toHaveLength(1);
    expect(m.invoiceCreate).toHaveBeenCalledTimes(1);
    expect(lastNumber()).toBe(1);
  });

  it("two concurrent calls create one invoice; the loser gets it back and its number is given back", async () => {
    const { m, svc, lastNumber } = setup();
    const [a, b] = await Promise.all([svc.fromAppointment("appt-1"), svc.fromAppointment("appt-1")]);
    // Both passed the "already invoiced?" check and both tried to insert...
    expect(m.invoiceCreate).toHaveBeenCalledTimes(2);
    // ...and the unique key let one through.
    expect(m.invoices).toHaveLength(1);
    expect(a).toEqual({ id: "inv-1" });
    expect(b).toEqual({ id: "inv-1" });
    expect(lastNumber()).toBe(1);
  });

  it("a unique violation with no appointment invoice behind it is not swallowed", async () => {
    const { m, svc } = setup();
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      "Unique constraint failed on the fields: (`tenantId`,`series`,`number`)",
      { code: "P2002", clientVersion: "5.22.0" },
    );
    m.invoiceCreate.mockRejectedValueOnce(p2002);
    await expect(svc.fromAppointment("appt-1")).rejects.toBe(p2002);
  });

  it("other errors propagate", async () => {
    const { m, svc } = setup();
    m.invoiceCreate.mockRejectedValueOnce(new Error("db down"));
    await expect(svc.fromAppointment("appt-1")).rejects.toThrow("db down");
  });

  it("returns the existing invoice even after the salon turned auto-invoicing off", async () => {
    const { m, svc } = setup();
    await svc.fromAppointment("appt-1");
    m.prisma.appointment.findUnique.mockImplementation(async () => ({
      id: "appt-1",
      tenantId: "tenant-1",
      status: "completed",
      tenant: { fiscalSettings: {} },
    }));
    expect(await svc.fromAppointment("appt-1")).toEqual({ id: "inv-1" });
    expect(m.invoices).toHaveLength(1);
  });

  it("does nothing for an appointment not completed, or a salon that did not opt in", async () => {
    expect(await setup({ status: "confirmed" }).svc.fromAppointment("appt-1")).toBeNull();
    expect(await setup({}, { autoInvoiceAppointments: false }).svc.fromAppointment("appt-1")).toBeNull();
  });

  it("uses the salon's rate (IGIC 7 %)", async () => {
    const { m, svc } = setup({}, { defaultTaxRate: 7 });
    await svc.fromAppointment("appt-1");
    expect(m.invoices[0].totalCents).toBe(3210);
  });

  it("a salon whose prices include the tax: invoiced at what the client paid, 24,79 + 5,21", async () => {
    const { m, svc } = setup({}, { pricesIncludeTax: true });
    await svc.fromAppointment("appt-1");
    const inv = m.invoices[0];
    expect(inv.subtotalCents).toBe(2479);
    expect(inv.totalCents).toBe(3000);
    expect(inv.taxBreakdown).toEqual([{ rate: 21, baseCents: 2479, taxCents: 521 }]);
    // The stored line is the net one, like any other line.
    expect(m.invoiceLines[0]).toMatchObject({ unitPriceCents: 2479, taxCents: 521, totalCents: 3000 });
  });

  it("IGIC 7 %, prices including the tax: 28,04 + 1,96 = 30,00", async () => {
    const { m, svc } = setup({}, { defaultTaxRate: 7, pricesIncludeTax: true });
    await svc.fromAppointment("appt-1");
    expect(m.invoices[0].totalCents).toBe(3000);
    expect(m.invoices[0].subtotalCents).toBe(2804);
  });

  it("pricesIncludeTax false is the tax on top, as without the key", async () => {
    const { m, svc } = setup({}, { pricesIncludeTax: false });
    await svc.fromAppointment("appt-1");
    expect(m.invoices[0].totalCents).toBe(3630);
  });
});

describe("InvoiceService.fromOrder", () => {
  function setup(
    items: Array<{ quantity: number; unitPrice: string; product: { name: string; taxRate: unknown } | null }>,
    fiscalSettings: Record<string, unknown>,
  ) {
    const m = makePrismaMock();
    m.prisma.order.findUnique = async () => ({
      id: "order-1",
      tenantId: "tenant-1",
      orderNumber: "T-0001",
      status: "completed",
      items: items.map((it, i) => ({ productId: `p-${i + 1}`, ...it, unitPrice: new Prisma.Decimal(it.unitPrice) })),
      client: null,
      tenant: { name: "Salón Luna", fiscalSettings },
    });
    const svc = new InvoiceService(m.prisma, new InvoiceCalculator(), {} as any);
    return { m, svc };
  }

  it("a salon without the setting: the tax goes on top of the till price", async () => {
    const { m, svc } = setup([{ quantity: 2, unitPrice: "10.00", product: { name: "Champú", taxRate: null } }], {
      defaultTaxRate: 21,
    });
    await svc.fromOrder("order-1");
    expect(m.invoices[0].subtotalCents).toBe(2000);
    expect(m.invoices[0].totalCents).toBe(2420);
  });

  it("a salon whose prices include the tax: the till price is the total", async () => {
    const { m, svc } = setup([{ quantity: 2, unitPrice: "12.10", product: { name: "Champú", taxRate: null } }], {
      defaultTaxRate: 21,
      pricesIncludeTax: true,
    });
    await svc.fromOrder("order-1");
    expect(m.invoices[0].totalCents).toBe(2420);
    expect(m.invoices[0].subtotalCents).toBe(2000);
  });

  it("the order's discount comes off its lines, tax on what is left, in both price modes", async () => {
    const items = [
      { quantity: 2, unitPrice: "10.00", product: { name: "Champú", taxRate: null } },
      { quantity: 1, unitPrice: "20.00", product: { name: "Cepillo", taxRate: null } },
    ];
    for (const [settings, subtotal, total] of [
      [{ defaultTaxRate: 21 }, 3600, 4356],
      // Each 18,00 line: 14,88 + 3,12 (rounded per line).
      [{ defaultTaxRate: 21, pricesIncludeTax: true }, 2976, 3600],
    ] as const) {
      const { m, svc } = setup(items as any, settings);
      const order = await m.prisma.order.findUnique();
      m.prisma.order.findUnique = async () => ({ ...order, discount: new Prisma.Decimal("4.00") });
      await svc.fromOrder("order-1");
      expect(m.invoices[0].subtotalCents).toBe(subtotal);
      expect(m.invoices[0].totalCents).toBe(total);
      // 4,00 shared in proportion: 2,00 on each 20,00 line, 10 % each.
      expect(m.invoiceLines.map((l: any) => Number(l.discountPct))).toEqual([10, 10]);
    }
  });

  it("a product with its own rate (a fraction, 0.10) is invoiced at 10 %, not 0,10 %", async () => {
    const { m, svc } = setup(
      [
        { quantity: 1, unitPrice: "11.00", product: { name: "Libro", taxRate: new Prisma.Decimal("0.10") } },
        { quantity: 1, unitPrice: "12.10", product: { name: "Champú", taxRate: null } },
      ],
      { defaultTaxRate: 21, pricesIncludeTax: true },
    );
    await svc.fromOrder("order-1");
    const inv = m.invoices[0];
    expect(inv.totalCents).toBe(2310);
    expect(inv.taxBreakdown).toEqual([
      { rate: 21, baseCents: 1000, taxCents: 210 },
      { rate: 10, baseCents: 1000, taxCents: 100 },
    ]);
    expect(m.invoiceLines.map((l) => Number(l.taxRate))).toEqual([10, 21]);
  });

  it("IGIC 7 %, prices on top: 10,00 + 0,70", async () => {
    const { m, svc } = setup([{ quantity: 1, unitPrice: "10.00", product: { name: "Laca", taxRate: null } }], {
      defaultTaxRate: 7,
      taxRegime: "igic",
    });
    await svc.fromOrder("order-1");
    expect(m.invoices[0].totalCents).toBe(1070);
  });
});
