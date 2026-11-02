import { Logger } from "@nestjs/common";
import { InvoiceService } from "./invoices.service";
import { InvoiceCalculator } from "./invoice-calculator.service";
import { invoiceStore } from "./invoice-store.testing";
import {
  IssuerIncompleteException,
  issuerBlockFrom,
  issuerBlocking,
  issuerIncompleteMessage,
  issuerMissing,
  issuerProblem,
  issuerStatus,
} from "./invoice-issuer";

/**
 * C2: invoices were issued with no NIF, razón social or address of the salon
 * (mandatory on every invoice, arts. 6-7 RD 1619/2012). The panel warns now;
 * from INVOICE_ISSUER_BLOCK_FROM issuing one without them is refused (422),
 * except at the till, where the sale goes through without its invoice
 * (pos-sale-rules.spec.ts), and the automatic appointment invoice, which is
 * skipped and logged.
 */

const COMPLETE = {
  taxId: "B12345674",
  legalName: "Salón Prueba SL",
  street: "Calle Mayor 1",
  postalCode: "28001",
  city: "Madrid",
  fiscalSettings: {},
  timezone: "Europe/Madrid",
};
const EMPTY = { taxId: null, legalName: null, street: null, postalCode: null, city: null, fiscalSettings: {}, timezone: "Europe/Madrid" };
const env = (value?: string) => ({ INVOICE_ISSUER_BLOCK_FROM: value }) as NodeJS.ProcessEnv;

describe("issuerMissing", () => {
  it("names what is missing, in order", () => {
    expect(issuerMissing(COMPLETE)).toEqual([]);
    expect(issuerMissing(EMPTY)).toEqual(["taxId", "legalName", "address"]);
    expect(issuerMissing({ ...COMPLETE, city: "  " })).toEqual(["address"]);
    expect(issuerMissing({ ...COMPLETE, legalName: "" })).toEqual(["legalName"]);
  });

  it("takes the NIF still kept only in fiscalSettings.tenantNif", () => {
    expect(issuerMissing({ ...COMPLETE, taxId: null, fiscalSettings: { tenantNif: "B12345674" } })).toEqual([]);
  });

  it("says in Spanish what is missing and where to fill it", () => {
    expect(issuerIncompleteMessage(["taxId", "legalName", "address"])).toBe(
      "No se puede emitir la factura: faltan el NIF, la razón social y la dirección fiscal (calle, código postal y ciudad) del salón, " +
        "que tienen que aparecer en todas las facturas. Rellénalos en Ajustes > Cumplimiento fiscal español (NIF y razón social) " +
        "y en Ajustes > Datos del salón (dirección).",
    );
    expect(issuerIncompleteMessage(["taxId"])).toMatch(/^No se puede emitir la factura: falta el NIF del salón, que tiene que/);
  });
});

describe("INVOICE_ISSUER_BLOCK_FROM", () => {
  const madridNoon = new Date("2027-01-01T11:00:00.000Z");

  it("unset or empty: warn only", () => {
    expect(issuerBlockFrom(env())).toBeNull();
    expect(issuerBlockFrom(env("  "))).toBeNull();
    expect(issuerBlocking("Europe/Madrid", madridNoon, env())).toBe(false);
  });

  it("an ISO date: refused from that day on, the salon's", () => {
    expect(issuerBlockFrom(env("2027-01-01"))).toBe("2027-01-01");
    expect(issuerBlockFrom(env("2027-01-01T00:00:00Z"))).toBe("2027-01-01");
    expect(issuerBlocking("Europe/Madrid", new Date("2026-12-31T22:00:00.000Z"), env("2027-01-01"))).toBe(false);
    // 23:30 UTC on 31 December is already 1 January in Madrid.
    expect(issuerBlocking("Europe/Madrid", new Date("2026-12-31T23:30:00.000Z"), env("2027-01-01"))).toBe(true);
    expect(issuerBlocking("Europe/Madrid", madridNoon, env("2026-11-02"))).toBe(true);
  });

  it("not a date: warn only, and logged", () => {
    const error = jest.spyOn(Logger.prototype, "error").mockImplementation(() => undefined);
    for (const bad of ["enero", "2027-13-01", "2027-02-30", "01/01/2027"]) {
      expect(issuerBlockFrom(env(bad))).toBeNull();
      expect(issuerBlocking("Europe/Madrid", madridNoon, env(bad))).toBe(false);
    }
    expect(error).toHaveBeenCalled();
    expect(String(error.mock.calls[0][0])).toMatch(/INVOICE_ISSUER_BLOCK_FROM/);
    error.mockRestore();
  });

  it("issuerProblem: null when complete or warn only, the missing fields when blocking", () => {
    expect(issuerProblem(EMPTY, madridNoon, env())).toBeNull();
    expect(issuerProblem(COMPLETE, madridNoon, env("2027-01-01"))).toBeNull();
    expect(issuerProblem(EMPTY, madridNoon, env("2027-01-01"))).toEqual(["taxId", "legalName", "address"]);
  });

  it("the status the panel reads", () => {
    expect(issuerStatus(EMPTY, madridNoon, env())).toEqual({
      complete: false,
      missing: ["taxId", "legalName", "address"],
      blockFrom: null,
      blocking: false,
      message: issuerIncompleteMessage(["taxId", "legalName", "address"]),
    });
    expect(issuerStatus(COMPLETE, madridNoon, env("2027-01-01"))).toMatchObject({ complete: true, blocking: false, message: null });
    expect(issuerStatus(EMPTY, madridNoon, env("2027-01-01"))).toMatchObject({ blockFrom: "2027-01-01", blocking: true });
  });
});

describe("InvoiceService: issuing without issuer data", () => {
  const saved = process.env.INVOICE_ISSUER_BLOCK_FROM;
  afterEach(() => {
    if (saved === undefined) delete process.env.INVOICE_ISSUER_BLOCK_FROM;
    else process.env.INVOICE_ISSUER_BLOCK_FROM = saved;
  });

  function service(tenant: Record<string, unknown>) {
    const store = invoiceStore();
    store.prisma.tenant.findUnique = jest.fn(async () => ({ fiscalMode: "none", name: "Salón Prueba", ...tenant }));
    const invoices = new InvoiceService(store.prisma, new InvoiceCalculator(), { dispatchInvoice: jest.fn() } as any);
    jest.spyOn(invoices, "afterIssue").mockImplementation(() => undefined);
    return { invoices, store };
  }
  const manual = {
    tenantId: "t1",
    recipientName: "Ana Prueba",
    lines: [{ description: "Corte", quantity: 1, unitPriceCents: 3000, taxRate: 21 }],
  };

  it("warn only (no date set): the invoice is issued", async () => {
    delete process.env.INVOICE_ISSUER_BLOCK_FROM;
    const { invoices, store } = service(EMPTY);
    await expect(invoices.createManual(manual)).resolves.toEqual({ id: "inv-1" });
    expect(store.invoices.size).toBe(1);
  });

  it("blocking: a manual invoice is refused with a Spanish 422 that says what is missing", async () => {
    process.env.INVOICE_ISSUER_BLOCK_FROM = "2020-01-01";
    const { invoices, store } = service({ ...COMPLETE, legalName: null, street: "" });
    const err = await invoices.createManual(manual).catch((e) => e);
    expect(err).toBeInstanceOf(IssuerIncompleteException);
    expect(err.getStatus()).toBe(422);
    expect(err.message).toMatch(/faltan la razón social y la dirección fiscal/);
    expect((err.getResponse() as any).missing).toEqual(["legalName", "address"]);
    expect(store.invoices.size).toBe(0);
  });

  it("blocking, with the data filled in: issued", async () => {
    process.env.INVOICE_ISSUER_BLOCK_FROM = "2020-01-01";
    const { invoices, store } = service(COMPLETE);
    await invoices.createManual(manual);
    expect([...store.invoices.values()][0]).toMatchObject({ issuerNameAtIssue: "Salón Prueba SL", issuerTaxIdAtIssue: "B12345674" });
  });

  it("blocking: the till's simplified invoice is refused too (the till asks first and skips it)", async () => {
    process.env.INVOICE_ISSUER_BLOCK_FROM = "2020-01-01";
    const { invoices } = service(EMPTY);
    await expect(invoices.issuerProblem("t1")).resolves.toEqual(["taxId", "legalName", "address"]);
    await expect(
      invoices.issueSimplifiedInvoiceForSale(invoiceStore().prisma, {
        tenantId: "t1",
        saleId: "sale-1",
        lines: [{ description: "Champú", quantity: 1, unitPriceCents: 1000, taxRate: 21 }],
      }),
    ).rejects.toBeInstanceOf(IssuerIncompleteException);
  });

  describe("appointments", () => {
    function withAppointment(tenant: Record<string, unknown>) {
      const s = service(tenant);
      s.store.prisma.appointment = {
        findUnique: jest.fn(async () => ({
          id: "apt-1",
          tenantId: "t1",
          status: "completed",
          price: "30.00",
          client: { id: "c1", firstName: "Ana", lastName: "Prueba", taxId: null },
          service: { id: "svc1", name: "Corte", price: "30.00" },
          services: [],
          tenant: { fiscalSettings: { autoInvoiceAppointments: true, defaultTaxRate: 21 } },
        })),
      };
      s.store.prisma.service = { findMany: jest.fn(async () => []) };
      return s;
    }

    it("blocking: the automatic invoice is skipped and logged, not failed", async () => {
      process.env.INVOICE_ISSUER_BLOCK_FROM = "2020-01-01";
      const warn = jest.spyOn(Logger.prototype, "warn").mockImplementation(() => undefined);
      const { invoices, store } = withAppointment(EMPTY);
      await expect(invoices.fromAppointment("apt-1")).resolves.toBeNull();
      expect(store.invoices.size).toBe(0);
      expect(warn.mock.calls.some((c) => /automatic invoice skipped/.test(String(c[0])))).toBe(true);
      warn.mockRestore();
    });

    it("blocking: invoicing it by hand answers the 422", async () => {
      process.env.INVOICE_ISSUER_BLOCK_FROM = "2020-01-01";
      const { invoices } = withAppointment(EMPTY);
      await expect(invoices.fromAppointment("apt-1", { tenantId: "t1", requested: true })).rejects.toBeInstanceOf(
        IssuerIncompleteException,
      );
    });

    it("warn only: the automatic invoice is issued as before", async () => {
      delete process.env.INVOICE_ISSUER_BLOCK_FROM;
      const { invoices, store } = withAppointment(EMPTY);
      await expect(invoices.fromAppointment("apt-1")).resolves.toEqual({ id: "inv-1" });
      expect(store.invoices.size).toBe(1);
    });
  });
});
