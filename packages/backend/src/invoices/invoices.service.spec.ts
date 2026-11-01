/**
 * InvoiceService.allocateNumber + InvoiceService.create/fromAppointment
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
  // allocateNumber's INSERT ... ON CONFLICT DO UPDATE ... RETURNING on
  // fiscal_sequences: atomic in Postgres, one statement here.
  const queryRaw = jest.fn(async (sql: TemplateStringsArray, ...values: any[]) => {
    if (!sql.join("?").includes('"fiscal_sequences"')) return [];
    const [, tenantId, series, year] = values;
    const key = `${tenantId}|${series}|${year}`;
    const cur = sequences.get(key) ?? { tenantId, series, year, lastNumber: 0 };
    sequences.set(key, { ...cur, lastNumber: cur.lastNumber + 1 });
    return [{ lastNumber: cur.lastNumber + 1 }];
  });

  const invoiceCreate = jest.fn(async (args: any) => {
    // The unique key (tenantId, sourceType, sourceId) among invoices that are
    // not cancelled, as Postgres enforces it.
    const d = args.data;
    if (
      d.sourceId != null &&
      invoices.some(
        (i) =>
          i.tenantId === d.tenantId &&
          i.sourceType === d.sourceType &&
          i.sourceId === d.sourceId &&
          i.status !== "cancelled",
      )
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
    $queryRaw: queryRaw,
    invoice: {
      create: invoiceCreate,
      update: async () => ({}),
      findMany: async () => [],
      findUnique: async () => null,
      findFirst: jest.fn(async (args: any) => {
        const w = args?.where ?? {};
        const row = invoices.find((i) =>
          Object.keys(w).every((k) =>
            w[k] && typeof w[k] === "object" && "not" in w[k] ? i[k] !== w[k].not : i[k] === w[k],
          ),
        );
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
    queryRaw,
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
    expect(await svc.allocateNumber("tenant-1", "A", 2027)).toBe("2027-000001");
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

describe("invoice numbers from 2027 carry the year", () => {
  it("2026 keeps 000123; 2027 and later are 2027-000001, so a new year never reuses a number", async () => {
    const m = makePrismaMock();
    const svc = new InvoiceService(m.prisma, new InvoiceCalculator(), {} as any);
    expect(await svc.allocateNumber("tenant-1", "A", 2026)).toBe("000001");
    expect(await svc.allocateNumber("tenant-1", "A", 2027)).toBe("2027-000001");
    expect(await svc.allocateNumber("tenant-1", "A", 2027)).toBe("2027-000002");
    expect(await svc.allocateNumber("tenant-1", "R", 2028)).toBe("2028-000001");
  });

  it("allocates with one INSERT ... ON CONFLICT DO UPDATE ... RETURNING (atomic for a new counter too)", async () => {
    const m = makePrismaMock();
    const svc = new InvoiceService(m.prisma, new InvoiceCalculator(), {} as any);
    await svc.allocateNumber("tenant-1", "A", 2027);
    expect(m.queryRaw).toHaveBeenCalledTimes(1);
    const sql = (m.queryRaw.mock.calls[0][0] as unknown as string[]).join("?");
    expect(sql).toMatch(/INSERT INTO "fiscal_sequences"/);
    expect(sql).toMatch(/ON CONFLICT \("tenantId", "series", "year"\)/);
    expect(sql).toMatch(/DO UPDATE SET "lastNumber" = "fiscal_sequences"."lastNumber" \+ 1/);
    expect(sql).toMatch(/RETURNING "lastNumber"/);
    expect(m.queryRaw.mock.calls[0].slice(2)).toEqual(["tenant-1", "A", 2027]);
  });

  it("fails loudly rather than numbering an invoice 000000", async () => {
    const m = makePrismaMock();
    m.queryRaw.mockResolvedValueOnce([] as any);
    const svc = new InvoiceService(m.prisma, new InvoiceCalculator(), {} as any);
    await expect(svc.allocateNumber("tenant-1", "A", 2027)).rejects.toThrow(/numbering failed/);
  });

  const line = { description: "Corte", quantity: 1, unitPriceCents: 1000, taxRate: 21 };

  it("00:30 on 1 January in Madrid is 2027's (still 31 December in UTC): numbered and dated 2027", async () => {
    const m = makePrismaMock();
    m.prisma.tenant.findUnique.mockResolvedValue({ fiscalMode: "none", fiscalSettings: {}, timezone: "Europe/Madrid" });
    const svc = new InvoiceService(m.prisma, new InvoiceCalculator(), {} as any);
    await svc.create({ tenantId: "tenant-1", recipientName: "Ana", lines: [line], issueDate: new Date("2026-12-31T23:30:00Z") });
    expect(m.invoices[0].number).toBe("2027-000001");
    expect(m.invoices[0].issueDate.toISOString()).toBe("2027-01-01T00:00:00.000Z");
  });

  it("the same instant in the Canaries is still 2026", async () => {
    const m = makePrismaMock();
    m.prisma.tenant.findUnique.mockResolvedValue({ fiscalMode: "none", fiscalSettings: {}, timezone: "Atlantic/Canary" });
    const svc = new InvoiceService(m.prisma, new InvoiceCalculator(), {} as any);
    await svc.create({ tenantId: "tenant-1", recipientName: "Ana", lines: [line], issueDate: new Date("2026-12-31T23:30:00Z") });
    expect(m.invoices[0].number).toBe("000001");
    expect(m.invoices[0].issueDate.toISOString()).toBe("2026-12-31T00:00:00.000Z");
  });

  it("the issue date is the salon's day: 01:30 on 1 July in Madrid is not 30 June", async () => {
    const m = makePrismaMock();
    const svc = new InvoiceService(m.prisma, new InvoiceCalculator(), {} as any);
    await svc.create({ tenantId: "tenant-1", recipientName: "Ana", lines: [line], issueDate: new Date("2026-06-30T23:30:00Z") });
    expect(m.invoices[0].issueDate.toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("a date sent as a day (YYYY-MM-DD) is that day", async () => {
    const m = makePrismaMock();
    const svc = new InvoiceService(m.prisma, new InvoiceCalculator(), {} as any);
    await svc.create({ tenantId: "tenant-1", recipientName: "Ana", lines: [line], issueDate: new Date("2027-03-02") });
    expect(m.invoices[0].issueDate.toISOString()).toBe("2027-03-02T00:00:00.000Z");
    expect(m.invoices[0].number).toBe("2027-000001");
  });

  it("2026 and 2027 invoices of one series both go through: no unique violation on 1 January", async () => {
    const m = makePrismaMock();
    const svc = new InvoiceService(m.prisma, new InvoiceCalculator(), {} as any);
    for (const d of ["2026-12-30", "2026-12-31", "2027-01-01", "2027-01-02"]) {
      await svc.create({ tenantId: "tenant-1", recipientName: "Ana", lines: [line], issueDate: new Date(d) });
    }
    const numbers = m.invoices.map((i: any) => `${i.series}${i.number}`);
    expect(numbers).toEqual(["A000001", "A000002", "A2027-000001", "A2027-000002"]);
    expect(new Set(numbers).size).toBe(4);
  });
});

describe("InvoiceService.fromAppointment: client NIF, salon scope, invoicing again", () => {
  function setup(fiscalSettings: Record<string, unknown> = { autoInvoiceAppointments: true, defaultTaxRate: 21 }) {
    const m = makePrismaMock();
    const appointment = {
      id: "appt-1",
      tenantId: "tenant-1",
      status: "completed",
      price: new Prisma.Decimal("30.00"),
      serviceId: "svc-1",
      service: { name: "Corte" },
      client: { id: "client-1", firstName: "Ana", lastName: "López", taxId: "12345678Z" },
      tenant: { fiscalSettings },
    };
    m.prisma.appointment.findUnique.mockImplementation(async () => appointment);
    const svc = new InvoiceService(m.prisma, new InvoiceCalculator(), {} as any);
    return { m, svc, appointment };
  }

  it("copies the client's NIF onto the invoice", async () => {
    const { m, svc } = setup();
    await svc.fromAppointment("appt-1");
    expect(m.invoices[0].recipientTaxId).toBe("12345678Z");
  });

  it("an appointment without a client is invoiced to the final consumer, not to an id", async () => {
    const { m, svc, appointment } = setup();
    (appointment as any).client = null;
    await svc.fromAppointment("appt-1");
    expect(m.invoices[0].recipientName).toBe("Consumidor final");
    expect(m.invoices[0].recipientTaxId).toBeUndefined();
  });

  it("asked for by another salon: 404, nothing issued", async () => {
    const { m, svc } = setup();
    await expect(svc.fromAppointment("appt-1", { tenantId: "tenant-2", requested: true })).rejects.toThrow(
      "Cita no encontrada",
    );
    expect(await svc.fromAppointment("appt-1", { tenantId: "tenant-2" })).toBeNull();
    expect(m.invoices).toHaveLength(0);
  });

  it("asked for explicitly, it is invoiced even when automatic invoicing is off", async () => {
    const { m, svc } = setup({ defaultTaxRate: 21 });
    expect(await svc.fromAppointment("appt-1")).toBeNull();
    expect(await svc.fromAppointment("appt-1", { tenantId: "tenant-1", requested: true })).toEqual({ id: "inv-1" });
    expect(m.invoices).toHaveLength(1);
  });

  it("asked for explicitly before the appointment is completed: 400", async () => {
    const { svc, appointment } = setup();
    (appointment as any).status = "confirmed";
    await expect(svc.fromAppointment("appt-1", { tenantId: "tenant-1", requested: true })).rejects.toThrow(
      /completada/,
    );
  });

  it("once its invoice is cancelled, the appointment can be invoiced again", async () => {
    const { m, svc } = setup();
    expect(await svc.fromAppointment("appt-1")).toEqual({ id: "inv-1" });
    m.invoices[0].status = "cancelled";
    expect(await svc.fromAppointment("appt-1", { tenantId: "tenant-1", requested: true })).toEqual({ id: "inv-2" });
    expect(m.invoices.map((i: any) => [i.number, i.status])).toEqual([
      ["000001", "cancelled"],
      ["000002", "issued"],
    ]);
    // And the live one is the one returned from then on.
    expect(await svc.fromAppointment("appt-1")).toEqual({ id: "inv-2" });
  });
});
