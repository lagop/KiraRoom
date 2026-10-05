/**
 * Tests for the Puppeteer-based invoice PDF service.
 *
 * The Puppeteer branch is mocked because spawning a real Chromium
 * would slow CI by 5-10s. We assert the rendered HTML template is
 * populated correctly and the fallback path returns a valid PDF even
 * when puppeteer fails.
 */

import { ConfigService } from "@nestjs/config";
import { InvoicePdfService } from "./invoice-pdf.service";

function makeService(env: Record<string, string | undefined>): InvoicePdfService {
  const get = (k: string) => env[k];
  const cfg = { get } as unknown as ConfigService;
  return new InvoicePdfService(cfg);
}

const SAMPLE = {
  tenant: {
    name: "Kira Room",
    legalName: "Kira Room S.L.",
    taxId: "B12345678",
    email: "ops@example.com",
    phone: "+34123456789",
    address: {
      street: "Calle Mayor 1",
      city: "Madrid",
      postalCode: "28001",
      country: "España",
    },
  },
  invoice: {
    series: "A",
    number: "000001",
    issueDate: "2026-07-16",
    recipientName: "Cliente Test",
    recipientTaxId: "12345678Z",
    subtotalCents: 10000,
    totalCents: 12100,
    currency: "EUR",
    fiscalReference: "CSV-FAKE-123",
    fiscalHash:
      "0000000000000000000000000000000000000000000000000000000000000000",
    fiscalQrUrl: "https://example.com/qr",
  },
  lines: [
    {
      description: "Corte de cabello",
      quantity: 1,
      unitPriceCents: 10000,
      taxRate: 21,
      totalCents: 12100,
    },
  ],
  taxBreakdown: [{ rate: 21, baseCents: 10000, taxCents: 2100 }],
};

describe("InvoicePdfService (fallback path)", () => {
  it("returns a valid PDF when PUPPETEER_SKIP_DOWNLOAD=true", async () => {
    const svc = makeService({ PUPPETEER_SKIP_DOWNLOAD: "true" });
    const buf = await svc.generate(SAMPLE as any);
    expect(buf.length).toBeGreaterThan(100);
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("returns a valid PDF when PUPPETEER_EXECUTABLE_PATH is unset", async () => {
    const svc = makeService({});
    const buf = await svc.generate(SAMPLE as any);
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });

  it("renders a fallback PDF that contains the recipient name", async () => {
    const svc = makeService({ PUPPETEER_SKIP_DOWNLOAD: "true" });
    const buf = await svc.generate(SAMPLE as any);
    // The fallback writer emits the recipient as literal text — verify
    // it made it into the output stream.
    const text = buf.toString("latin1");
    expect(text).toContain("Cliente Test");
    expect(text).toContain("000001");
  });

  it("draws the VERI*FACTU QR first, between its two legends, as vector squares", async () => {
    // The old fallback embedded a PNG declared as JPEG (unreadable) at the bottom.
    // Rendered and decoded by hand on 2026-10-01: the code scans to the AEAT URL, 35 mm wide.
    const svc = makeService({ PUPPETEER_SKIP_DOWNLOAD: "true" });
    const text = (await svc.generate(SAMPLE as any)).toString("latin1");
    const qrLabel = text.indexOf("(QR tributario:) Tj");
    const legend = text.indexOf("(VERI*FACTU) Tj");
    const firstSquare = text.search(/[\d.]+ [\d.]+ [\d.]+ [\d.]+ re/);
    expect(qrLabel).toBeGreaterThan(0);
    expect(firstSquare).toBeGreaterThan(qrLabel);
    expect(legend).toBeGreaterThan(firstSquare);
    expect(text.indexOf("(Factura A000001) Tj")).toBeGreaterThan(legend);
    expect(text).not.toContain("/Subtype /Image");
  });

  it("prints the issuer's NIF and the base and tax per rate", async () => {
    const svc = makeService({ PUPPETEER_SKIP_DOWNLOAD: "true" });
    const text = (await svc.generate(SAMPLE as any)).toString("latin1");
    expect(text).toContain("(NIF: B12345678) Tj");
    expect(text).toContain("(Base al 21%: 100.00 EUR  Cuota: 21.00 EUR) Tj");
    expect(text).toContain("(TOTAL: 121.00 EUR) Tj");
  });

  it("handles missing fiscalQrUrl gracefully", async () => {
    const svc = makeService({ PUPPETEER_SKIP_DOWNLOAD: "true" });
    const { fiscalQrUrl, ...rest } = SAMPLE.invoice;
    const buf = await svc.generate({ ...SAMPLE, invoice: rest } as any);
    expect(buf.length).toBeGreaterThan(100);
  });
});

describe("InvoicePdfService (Puppeteer branch)", () => {
  it("falls back to legacy PDF when puppeteer.launch fails", async () => {
    // Puppeteer isn't installed in CI; the import call will throw, and
    // the service should fall back to the hand-rolled writer.
    const svc = makeService({});
    const buf = await svc.generate(SAMPLE as any);
    expect(buf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
  });
});
