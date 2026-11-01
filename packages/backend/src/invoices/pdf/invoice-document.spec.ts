import { addressLines, buildInvoiceDocument, formatDateInZone, InvoicePdfInput } from "./invoice-document";

/**
 * What the invoice PDF says (RD 1619/2012): the content model both renderers
 * print. The controller used to pass the salon's NIF and address as null.
 */
function input(over: Partial<InvoicePdfInput> & { invoice?: Partial<InvoicePdfInput["invoice"]> } = {}): InvoicePdfInput {
  return {
    tenant: {
      name: "Salón Luna",
      legalName: "Luna Estética S.L.",
      taxId: "B12345678",
      address: { street: "Calle Mayor 1", postalCode: "28001", city: "Madrid", state: "Madrid", country: "ES" },
      email: "hola@luna.es",
      phone: "+34 600 000 000",
      ...over.tenant,
    },
    invoice: {
      series: "A",
      number: "000007",
      issueDate: "2026-07-16T10:00:00.000Z",
      recipientName: "Ana López Núñez",
      recipientTaxId: null,
      subtotalCents: 2479,
      totalCents: 3000,
      currency: "EUR",
      ...over.invoice,
    },
    lines: over.lines ?? [
      { description: "Corte y peinado", quantity: 1, unitPriceCents: 2479, discountPct: 0, taxRate: 21, totalCents: 3000 },
    ],
    taxBreakdown: over.taxBreakdown ?? [{ rate: 21, baseCents: 2479, taxCents: 521 }],
    taxLabel: over.taxLabel,
    timezone: over.timezone,
    rectifies: over.rectifies,
  };
}

describe("invoice document: which document it is", () => {
  it("without the client's NIF it is a factura simplificada", () => {
    expect(buildInvoiceDocument(input()).title).toBe("Factura simplificada");
  });

  it("with the client's NIF it is a factura, and shows the NIF and address", () => {
    const doc = buildInvoiceDocument(
      input({
        invoice: {
          recipientTaxId: "12345678Z",
          recipientAddress: { street: "Avda. de la Constitución 3", postalCode: "41001", city: "Sevilla" },
        },
      }),
    );
    expect(doc.title).toBe("Factura");
    expect(doc.recipient).toEqual({
      name: "Ana López Núñez",
      details: ["NIF: 12345678Z", "Avda. de la Constitución 3", "41001 Sevilla"],
    });
  });

  it("series R, or a negative total, is a factura rectificativa with the original and the reason", () => {
    const doc = buildInvoiceDocument(
      input({
        invoice: {
          series: "R",
          number: "000002",
          totalCents: -3000,
          subtotalCents: -2479,
          notes: "Rectificación de A000007: Servicio no realizado\nCANCELLED: otra cosa",
        },
        rectifies: { series: "A", number: "000007", issueDate: "2026-07-10T09:00:00.000Z" },
      }),
    );
    expect(doc.title).toBe("Factura rectificativa");
    expect(doc.rectification).toEqual({ original: "A000007", originalDate: "10/07/2026", reason: "Servicio no realizado" });
    expect(doc.totals.total).toMatch(/^-30,00\s€$/);
  });

  it("a rectificativa whose original is not found still names it from its note", () => {
    const doc = buildInvoiceDocument(
      input({ invoice: { series: "R", totalCents: -100, notes: "Rectificación de A000123: Descuento" } }),
    );
    expect(doc.rectification).toEqual({ original: "A000123", originalDate: null, reason: "Descuento" });
  });
});

describe("invoice document: issuer", () => {
  it("razón social, commercial name, NIF and full address", () => {
    const doc = buildInvoiceDocument(input());
    expect(doc.issuer).toEqual({
      name: "Luna Estética S.L.",
      details: [
        "Salón Luna",
        "NIF: B12345678",
        "Calle Mayor 1",
        "28001 Madrid",
        "España",
        "hola@luna.es",
        "+34 600 000 000",
      ],
    });
  });

  it("prefers what was snapshotted when the invoice was issued", () => {
    const doc = buildInvoiceDocument(
      input({ invoice: { issuerNameAtIssue: "Antiguo Nombre S.L.", issuerTaxIdAtIssue: "B87654321" } }),
    );
    expect(doc.issuer.name).toBe("Antiguo Nombre S.L.");
    expect(doc.issuer.details).toContain("NIF: B87654321");
    expect(doc.issuer.details).not.toContain("NIF: B12345678");
  });

  it("without a razón social, the salon's name", () => {
    const doc = buildInvoiceDocument(input({ tenant: { name: "Salón Luna", legalName: null, taxId: null, address: null } }));
    expect(doc.issuer.name).toBe("Salón Luna");
    expect(doc.issuer.details).toEqual(["hola@luna.es", "+34 600 000 000"]);
  });
});

describe("invoice document: dates, amounts and taxes", () => {
  it("the issue date is the salon's calendar day, dd/mm/yyyy", () => {
    // 23:30 UTC on 31 October: already 1 November in Madrid, still 31 October in the Canaries.
    expect(formatDateInZone("2026-10-31T23:30:00.000Z", "Europe/Madrid")).toBe("01/11/2026");
    expect(formatDateInZone("2026-10-31T23:30:00.000Z", "Atlantic/Canary")).toBe("31/10/2026");
    expect(buildInvoiceDocument(input({ timezone: "Atlantic/Canary", invoice: { issueDate: "2026-10-31T23:30:00.000Z" } })).issueDate).toBe(
      "31/10/2026",
    );
    // An unknown zone is not a crash.
    expect(formatDateInZone("2026-07-16T10:00:00.000Z", "Mars/Olympus")).toBe("16/07/2026");
  });

  it("lines with quantity, unit price, rate and total, in euros the Spanish way", () => {
    const doc = buildInvoiceDocument(
      input({
        lines: [{ description: "Tinte", quantity: 2, unitPriceCents: 2000, discountPct: 10, taxRate: 21, totalCents: 4356 }],
      }),
    );
    const plain = JSON.parse(JSON.stringify(doc.lines).replace(/\u00a0/g, " "));
    expect(plain).toEqual([
      { description: "Tinte", discount: "Dto. 10 %", quantity: "2", unitPrice: "18,00 €", taxRate: "21 %", total: "43,56 €" },
    ]);
  });

  it("the breakdown per rate is labelled with the salon's tax: IGIC in the Canaries", () => {
    const doc = buildInvoiceDocument(
      input({
        taxLabel: "IGIC",
        taxBreakdown: [
          { rate: 3, baseCents: 1000, taxCents: 30 },
          { rate: 9.5, baseCents: 2000, taxCents: 190 },
        ],
      }),
    );
    const plain = JSON.parse(JSON.stringify(doc.taxBreakdown).replace(/\u00a0/g, " "));
    expect(plain).toEqual([
      { label: "IGIC 9,5 %", rate: "9,5 %", base: "20,00 €", tax: "1,90 €" },
      { label: "IGIC 3 %", rate: "3 %", base: "10,00 €", tax: "0,30 €" },
    ]);
    expect(doc.taxLabel).toBe("IGIC");
  });

  it("a cancelled invoice says so", () => {
    expect(buildInvoiceDocument(input({ invoice: { status: "cancelled" } })).cancelled).toBe(true);
  });
});

describe("addressLines", () => {
  it("reads the usual shapes and plain text", () => {
    expect(addressLines({ address: "C/ Sol 2", zip: "35001", city: "Las Palmas", province: "Las Palmas", country: "ES" })).toEqual([
      "C/ Sol 2",
      "35001 Las Palmas",
      "España",
    ]);
    expect(addressLines("C/ Sol 2\n35001 Las Palmas")).toEqual(["C/ Sol 2", "35001 Las Palmas"]);
    expect(addressLines(null)).toEqual([]);
  });
});
