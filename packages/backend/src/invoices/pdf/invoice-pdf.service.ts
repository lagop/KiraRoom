import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as QRCode from "qrcode";
import { buildInvoiceHtml, InvoiceTemplateData } from "./invoice-template";

export interface InvoiceLine {
  description: string;
  quantity: number;
  unitPriceCents: number;
  taxRate: number;
  discountPct?: number;
  totalCents: number;
}

/**
 * AEAT-style PDF renderer.
 *
 * Uses puppeteer-core to render an HTML template to PDF. CI / dev
 * environments without a real Chrome can fall back to the hand-rolled
 * PDF built by `LegacyInvoicePdfService` via the env toggle
 * `PUPPETEER_SKIP_DOWNLOAD=true`.
 *
 * The fallback path preserves the previous Courier-plaintext output for
 * environments where Chromium isn't available, so we don't break dev
 * workflows that don't have a browser installed.
 */
@Injectable()
export class InvoicePdfService {
  private readonly logger = new Logger(InvoicePdfService.name);

  constructor(private readonly config: ConfigService) {}

  /**
   * Returns a Uint8Array containing the rendered PDF. The caller is
   * responsible for setting the right Content-Type header.
   */
  async generate(input: {
    tenant: any;
    invoice: {
      series: string;
      number: string;
      issueDate: string;
      recipientName: string;
      recipientTaxId?: string | null;
      recipientAddress?: Record<string, unknown> | null;
      subtotalCents: number;
      totalCents: number;
      currency: string;
      fiscalReference?: string | null;
      fiscalHash?: string | null;
      fiscalQrUrl?: string | null;
    };
    lines: InvoiceLine[];
    taxBreakdown: Array<{ rate: number; baseCents: number; taxCents: number }>;
  }): Promise<Buffer> {
    if (this.shouldSkipPuppeteer()) {
      this.logger.debug(
        "PUPPETEER_SKIP_DOWNLOAD=true — falling back to hand-rolled PDF",
      );
      return this.fallbackPdf(input);
    }

    const qrPngDataUrl = input.invoice.fiscalQrUrl
      ? await QRCode.toDataURL(input.invoice.fiscalQrUrl, {
          errorCorrectionLevel: "M",
          width: 220,
        })
      : undefined;

    const html = buildInvoiceHtml({
      ...input,
      qrPngDataUrl,
    } as InvoiceTemplateData);

    let browser: any = null;
    try {
      const puppeteer = (await import("puppeteer-core")).default;
      const executablePath = this.config.get<string>(
        "PUPPETEER_EXECUTABLE_PATH",
      );
      browser = await puppeteer.launch({
        headless: true,
        args: [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-dev-shm-usage",
        ],
        executablePath: executablePath || undefined,
      });
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: "networkidle0" });
      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        margin: { top: "12mm", bottom: "12mm", left: "12mm", right: "12mm" },
      });
      return Buffer.from(pdf);
    } catch (err) {
      this.logger.warn(
        `Puppeteer render failed (${(err as Error).message}) — falling back to legacy PDF`,
      );
      return this.fallbackPdf(input);
    } finally {
      if (browser) {
        try {
          await browser.close();
        } catch {
          // ignore
        }
      }
    }
  }

  private shouldSkipPuppeteer(): boolean {
    return (
      this.config.get<string>("PUPPETEER_SKIP_DOWNLOAD") === "true" ||
      !this.config.get<string>("PUPPETEER_EXECUTABLE_PATH")
    );
  }

  /**
   * Hand-rolled PDF 1.4 writer (Courier plaintext). Reused from the
   * pre-Phase-2 implementation. Kept as the CI fallback so the renderer
   * never crashes when a Chrome binary isn't available.
   */
  private async fallbackPdf(input: {
    tenant: any;
    invoice: any;
    lines: InvoiceLine[];
    taxBreakdown: Array<{ rate: number; baseCents: number; taxCents: number }>;
  }): Promise<Buffer> {
    // Drawn as vector squares: the old code embedded the PNG declared as a
    // JPEG (DCTDecode), so no reader could decode it, and it sat at the bottom.
    const qr = input.invoice.fiscalQrUrl
      ? createQr(input.invoice.fiscalQrUrl, { errorCorrectionLevel: "M" }).modules
      : null;
    const money = (cents: number) => `${(cents / 100).toFixed(2)} ${input.invoice.currency}`;
    const lines = [
      `Factura ${input.invoice.series}${input.invoice.number}`,
      `Fecha: ${input.invoice.issueDate}`,
      "",
      `Emisor: ${input.tenant.legalName ?? input.tenant.name}`,
      input.tenant.taxId ? `NIF: ${input.tenant.taxId}` : "",
      "",
      `Cliente: ${input.invoice.recipientName}`,
      input.invoice.recipientTaxId ? `NIF: ${input.invoice.recipientTaxId}` : "",
      "",
      "Detalle:",
      ...input.lines.map(
        (l) =>
          `  - ${l.description} x${l.quantity}: ${money(l.totalCents)} (${l.taxRate}% incl.)`,
      ),
      "",
      // Base and tax per rate: every invoice must show them (RD 1619/2012 art. 6-7).
      ...input.taxBreakdown.map(
        (t) => `Base al ${t.rate}%: ${money(t.baseCents)}  Cuota: ${money(t.taxCents)}`,
      ),
      `TOTAL: ${money(input.invoice.totalCents)}`,
      "",
      input.invoice.fiscalReference
        ? `CSV de la AEAT: ${input.invoice.fiscalReference}`
        : "",
    ].filter(Boolean);
    return buildPdf(lines, qr ? { size: qr.size, dark: (r: number, c: number) => !!qr.get(r, c) } : null);
  }
}

/** qrcode's matrix API (present at runtime, missing from its type declarations). */
const createQr = (
  QRCode as unknown as {
    create(text: string, options: { errorCorrectionLevel: "M" }): { modules: { size: number; get(row: number, col: number): number } };
  }
).create;

/** A QR code's module matrix. */
interface QrMatrix {
  size: number;
  dark: (row: number, col: number) => boolean;
}

/** 35 mm, within the 30-40 mm the QR spec asks for (1 mm = 72/25.4 pt). */
const QR_SIDE_PT = (35 * 72) / 25.4;

/**
 * Hand-rolled minimal PDF 1.4 writer, for environments without a Chrome
 * binary (production today). Text in Courier (WinAnsi, so Spanish accents
 * print) and, for VERI*FACTU invoices, the QR at the top of the page:
 * "QR tributario:" above it, "VERI*FACTU" below, then the invoice.
 */
function buildPdf(textLines: string[], qr: QrMatrix | null): Buffer {
  const left = 50;
  const ops: string[] = [];
  let y = 800;
  const text = (line: string, x: number, at: number) => {
    const safe = line.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
    ops.push("BT", "/F1 11 Tf", `${x} ${at.toFixed(2)} Td`, `(${safe}) Tj`, "ET");
  };

  if (qr) {
    text("QR tributario:", left, y);
    // At least 2 mm of blank space around the code (QR spec §4): ~5 mm here.
    const top = y - 14;
    const module = QR_SIDE_PT / qr.size;
    ops.push("0 g");
    for (let r = 0; r < qr.size; r++) {
      for (let c = 0; c < qr.size; c++) {
        if (!qr.dark(r, c)) continue;
        const x = left + c * module;
        const yy = top - (r + 1) * module;
        ops.push(`${x.toFixed(3)} ${yy.toFixed(3)} ${module.toFixed(3)} ${module.toFixed(3)} re`);
      }
    }
    ops.push("f");
    y = top - QR_SIDE_PT - 16;
    text("VERI*FACTU", left, y);
    y -= 28;
  }
  for (const line of textLines) {
    text(line, left, y);
    y -= 14;
  }

  const content = ops.join("\n") + "\n";
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 5 0 R /Resources << /Font << /F1 4 0 R >> >> >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>",
    `<< /Length ${Buffer.byteLength(content, "latin1")} >>\nstream\n${content}endstream`,
  ];
  let body = "%PDF-1.4\n%\xff\xff\xff\xff\n";
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(Buffer.byteLength(body, "latin1"));
    body += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  });
  const xrefStart = Buffer.byteLength(body, "latin1");
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
}
