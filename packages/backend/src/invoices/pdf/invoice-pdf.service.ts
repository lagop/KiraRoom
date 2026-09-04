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
    const qrPng = input.invoice.fiscalQrUrl
      ? await QRCode.toBuffer(input.invoice.fiscalQrUrl, {
          errorCorrectionLevel: "M",
          width: 200,
          margin: 1,
        })
      : null;
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
          `  - ${l.description} x${l.quantity} @ ${(l.unitPriceCents * (1 - (l.discountPct ?? 0) / 100)) / 100} = ${l.totalCents / 100} (${l.taxRate}% IVA)`,
      ),
      "",
      `Subtotal: ${input.invoice.subtotalCents / 100}`,
      `TOTAL:    ${input.invoice.totalCents / 100} ${input.invoice.currency}`,
      "",
      input.invoice.fiscalReference
        ? `Referencia fiscal: ${input.invoice.fiscalReference}`
        : "",
      qrPng ? "[QR embebido en la esquina inferior derecha]" : "",
    ].filter(Boolean);
    return buildPdf(lines, qrPng);
  }
}

/**
 * Hand-rolled minimal PDF 1.4 writer. Reused from the pre-Phase-2 service.
 * Kept as the fallback for environments without a Chrome binary.
 */
function buildPdf(textLines: string[], qrPng: Buffer | null): Buffer {
  const objects: string[] = [];
  const xref: number[] = [];
  let buffer = Buffer.from("%PDF-1.4\n%\xff\xff\xff\xff\n", "binary");

  function addObject(content: string): number {
    const id = objects.length + 1;
    xref.push(buffer.length);
    const obj = `${id} 0 obj\n${content}\nendobj\n`;
    buffer = Buffer.concat([buffer, Buffer.from(obj, "binary")]);
    objects.push(obj);
    return id;
  }

  const catalogId = addObject("<< /Type /Catalog /Pages 2 0 R >>");
  const pagesId = addObject("<< /Type /Pages /Kids [3 0 R] /Count 1 >>");
  const fontId = addObject(
    "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>",
  );
  const imageId = qrPng
    ? addObject(
        `<< /Type /XObject /Subtype /Image /Width 200 /Height 200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${qrPng.length} >>\nstream\n` +
          "" +
          "\nendstream",
      )
    : -1;
  const pageResources = imageId > 0
    ? `/Font ${fontId} 0 R /XObject << /Im1 ${imageId} 0 R >>`
    : `/Font ${fontId} 0 R`;
  const pageId = addObject(
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 5 0 R /Resources << ${pageResources} >> >>`,
  );
  const contentLines: string[] = ["BT", "/F1 11 Tf", "50 780 Td", "14 TL"];
  for (const line of textLines) {
    const safe = line
      .replace(/\\/g, "\\\\")
      .replace(/\(/g, "\\(")
      .replace(/\)/g, "\\)");
    contentLines.push(`(${safe}) Tj`, "T*");
  }
  contentLines.push("ET");
  if (imageId > 0) {
    contentLines.push(
      "q",
      "200 0 0 200 380 40 cm",
      "/Im1 Do",
      "Q",
    );
  }
  const contentBody = contentLines.join("\n");
  const contentStream = `${contentBody}\n`;
  const contentId = addObject(
    `<< /Length ${contentStream.length} >>\nstream\n${contentStream}endstream`,
  );
  if (qrPng && imageId > 0) {
    const placeholderLen = objects[imageId - 1].length;
    const newObj = `<< /Type /XObject /Subtype /Image /Width 200 /Height 200 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${qrPng.length} >>\nstream\n`;
    const headerBytes = Buffer.from(newObj, "binary");
    const trailing = Buffer.from("\nendstream\nendobj\n", "binary");
    const replacement = Buffer.concat([headerBytes, qrPng, trailing]);
    const oldStart = xref[imageId - 1];
    const oldEnd = oldStart + placeholderLen;
    buffer = Buffer.concat([
      buffer.subarray(0, oldStart),
      replacement,
      buffer.subarray(oldEnd),
    ]);
    const delta = replacement.length - placeholderLen;
    for (let i = imageId; i < xref.length; i++) {
      xref[i] += delta;
    }
  }
  let xrefStart = buffer.length;
  let xrefBody = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of xref) {
    xrefBody += `${off.toString().padStart(10, "0")} 00000 n \n`;
  }
  buffer = Buffer.concat([
    buffer,
    Buffer.from(xrefBody, "binary"),
    Buffer.from(
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`,
      "binary",
    ),
  ]);
  void catalogId;
  void pagesId;
  void pageId;
  void contentId;
  return buffer;
}
