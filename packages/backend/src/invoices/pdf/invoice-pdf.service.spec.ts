/**
 * The invoice PDF as served (no Chromium in CI or in the production image):
 * written directly by plain-pdf-writer.ts. These tests read the text back
 * out of the PDF and check what RD 1619/2012 asks it to say.
 *
 * The Chromium branch is not run here (it would need a browser); when it
 * cannot start, the service falls back to the same PDF.
 */

import { ConfigService } from "@nestjs/config";
import { InvoicePdfService } from "./invoice-pdf.service";
import { toWinAnsi, wrapText } from "./plain-pdf-writer";

function makeService(env: Record<string, string | undefined>): InvoicePdfService {
  const get = (k: string) => env[k];
  const cfg = { get } as unknown as ConfigService;
  return new InvoicePdfService(cfg);
}

/** WinAnsi byte -> Unicode, for the characters the writer maps outside Latin-1. */
const FROM_WIN_ANSI: Record<number, string> = { 0x80: "€", 0x96: "–", 0x97: "—", 0x93: "“", 0x94: "”", 0x91: "‘", 0x92: "’" };

/** The text the PDF shows: every `(...) Tj`, unescaped and decoded, one per line. */
function pdfText(buf: Buffer): string {
  const raw = buf.toString("latin1");
  const out: string[] = [];
  const re = /\(((?:\\.|[^\\)])*)\) Tj/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw))) {
    const unescaped = m[1].replace(/\\([\\()])/g, "$1");
    out.push(
      Array.from(unescaped)
        .map((ch) => FROM_WIN_ANSI[ch.charCodeAt(0)] ?? ch)
        .join("")
        .replace(/\u00a0/g, " "),
    );
  }
  return out.join("\n");
}

const SAMPLE = {
  tenant: {
    name: "Kira Room",
    legalName: "Kira Room S.L.",
    taxId: "B12345678",
    email: "ops@example.com",
    phone: "+34123456789",
    address: { street: "Calle Mayor 1", city: "Madrid", postalCode: "28001", country: "España" },
  },
  invoice: {
    series: "A",
    number: "000001",
    issueDate: "2026-07-16T10:00:00.000Z",
    recipientName: "María Peña Ibáñez",
    recipientTaxId: "12345678Z",
    recipientAddress: { street: "Plaza de España 4", postalCode: "38001", city: "Santa Cruz de Tenerife" },
    subtotalCents: 10000,
    totalCents: 12100,
    currency: "EUR",
    fiscalHash: "0000000000000000000000000000000000000000000000000000000000000000",
    fiscalQrUrl: "https://example.com/qr",
  },
  lines: [{ description: "Corte de cabello y peinado", quantity: 1, unitPriceCents: 10000, taxRate: 21, totalCents: 12100 }],
  taxBreakdown: [{ rate: 21, baseCents: 10000, taxCents: 2100 }],
  taxLabel: "IVA",
  timezone: "Europe/Madrid",
};

describe("InvoicePdfService: the PDF served without Chromium", () => {
  it("is a PDF when PUPPETEER_SKIP_DOWNLOAD=true or no browser path is set", async () => {
    for (const env of [{ PUPPETEER_SKIP_DOWNLOAD: "true", PUPPETEER_EXECUTABLE_PATH: "/x" }, {}]) {
      const buf = await makeService(env).generate(SAMPLE as any);
      expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
      expect(buf.toString("latin1").trimEnd().endsWith("%%EOF")).toBe(true);
    }
  });

  it("says what a factura must say, with accents and euros", async () => {
    const text = pdfText(await makeService({}).generate(SAMPLE as any));
    for (const expected of [
      "Factura",
      "Número: A000001 (serie A)",
      "Fecha de expedición: 16/07/2026",
      "EMISOR",
      "Kira Room S.L.",
      "NIF: B12345678",
      "Calle Mayor 1",
      "28001 Madrid",
      "CLIENTE",
      "María Peña Ibáñez",
      "NIF: 12345678Z",
      "Plaza de España 4",
      "38001 Santa Cruz de Tenerife",
      "DESCRIPCIÓN",
      "Corte de cabello y peinado",
      "100,00 €",
      "21 %",
      "BASE IMPONIBLE",
      "CUOTA",
      "IVA 21 %",
      "21,00 €",
      "121,00 €",
      "Página 1 de 1",
    ]) {
      expect(text.split("\n")).toContain(expected);
    }
    expect(text).not.toContain("Factura simplificada");
  });

  it("titles a simplificada and a rectificativa, with the invoice it rectifies and why", async () => {
    const svc = makeService({});
    const simple = pdfText(
      await svc.generate({ ...SAMPLE, invoice: { ...SAMPLE.invoice, recipientTaxId: null, recipientAddress: null } } as any),
    );
    expect(simple.split("\n")).toContain("Factura simplificada");

    const rect = pdfText(
      await svc.generate({
        ...SAMPLE,
        invoice: {
          ...SAMPLE.invoice,
          series: "R",
          number: "000004",
          totalCents: -12100,
          subtotalCents: -10000,
          notes: "Rectificación de A000001: Cobro duplicado (¡perdón!)",
        },
        lines: [{ ...SAMPLE.lines[0], quantity: -1, totalCents: -12100 }],
        taxBreakdown: [{ rate: 21, baseCents: -10000, taxCents: -2100 }],
        rectifies: { series: "A", number: "000001", issueDate: "2026-07-16T10:00:00.000Z" },
      } as any),
    );
    const lines = rect.split("\n");
    expect(lines).toContain("Factura rectificativa");
    expect(lines).toContain("Rectifica a la factura: A000001 de fecha 16/07/2026");
    expect(lines).toContain("Motivo: Cobro duplicado (¡perdón!)");
    expect(lines).toContain("-121,00 €");
  });

  it("labels the tax IGIC for a Canarian salon", async () => {
    const text = pdfText(
      await makeService({}).generate({
        ...SAMPLE,
        taxLabel: "IGIC",
        lines: [{ ...SAMPLE.lines[0], taxRate: 7, totalCents: 10700 }],
        taxBreakdown: [{ rate: 7, baseCents: 10000, taxCents: 700 }],
        invoice: { ...SAMPLE.invoice, totalCents: 10700 },
      } as any),
    );
    expect(text.split("\n")).toEqual(expect.arrayContaining(["IGIC", "IGIC 7 %", "7,00 €", "107,00 €"]));
    expect(text).not.toMatch(/\bIVA\b/);
  });

  it("flows a long invoice onto more pages, repeating the table header", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => ({
      description: `Servicio número ${i + 1}`,
      quantity: 1,
      unitPriceCents: 1000,
      taxRate: 21,
      totalCents: 1210,
    }));
    const buf = await makeService({}).generate({ ...SAMPLE, lines } as any);
    const text = pdfText(buf);
    const pages = Number(/\/Count (\d+)/.exec(buf.toString("latin1"))![1]);
    expect(pages).toBeGreaterThan(1);
    expect(text).toContain(`Página ${pages} de ${pages}`);
    expect(text).toContain("Factura A000001 (continuación)");
    expect(text.split("\n").filter((l) => l === "DESCRIPCIÓN")).toHaveLength(pages);
    expect(text).toContain("Servicio número 80");
  });

  it("draws the fiscal QR when there is one", async () => {
    const svc = makeService({});
    const withQr = await svc.generate(SAMPLE as any);
    const withoutQr = await svc.generate({ ...SAMPLE, invoice: { ...SAMPLE.invoice, fiscalQrUrl: null } } as any);
    expect(withQr.length).toBeGreaterThan(withoutQr.length + 1000);
  });

  it("falls back to the same PDF when the browser cannot start", async () => {
    const svc = makeService({ PUPPETEER_EXECUTABLE_PATH: "/no/such/chromium" });
    const text = pdfText(await svc.generate(SAMPLE as any));
    expect(text.split("\n")).toContain("María Peña Ibáñez");
  }, 30_000);
});

describe("plain PDF writer helpers", () => {
  it("encodes Spanish text and the euro sign in WinAnsi", () => {
    expect(Buffer.from(toWinAnsi("Peña €"), "latin1")).toEqual(Buffer.from([0x50, 0x65, 0xf1, 0x61, 0x20, 0x80]));
    // Outside WinAnsi: the base letter, else "?".
    expect(toWinAnsi("Łódź ✂")).toBe("?ódz ?");
  });

  it("wraps long descriptions within the column", () => {
    const lines = wrapText("Tratamiento de queratina con hidratación profunda y corte", 100, 10);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ")).toBe("Tratamiento de queratina con hidratación profunda y corte");
  });
});
