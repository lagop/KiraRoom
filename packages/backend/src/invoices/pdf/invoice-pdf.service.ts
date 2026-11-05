import { Injectable, Logger } from "@nestjs/common";
import { ConfigService } from "@nestjs/config";
import * as QRCode from "qrcode";
import { buildInvoiceDocument, InvoiceDocument, InvoicePdfInput } from "./invoice-document";
import { renderInvoiceHtml } from "./invoice-template";
import { renderPlainInvoicePdf } from "./plain-pdf-writer";

export type { InvoiceLine, InvoicePdfInput } from "./invoice-document";

/** How long a Chromium render may take before the plain PDF is used instead. */
const RENDER_TIMEOUT_MS = 20_000;

/**
 * The invoice PDF.
 *
 * Both renderers print the same content model (invoice-document.ts):
 *  - the PDF written directly (plain-pdf-writer.ts): standard fonts, A4,
 *    multi-page. What production serves: its image has no browser, and
 *    installing Alpine's chromium would add over 300 MB to it and a browser
 *    start per download;
 *  - Chromium through puppeteer-core, printing the HTML template, only when
 *    PUPPETEER_EXECUTABLE_PATH points at a browser (and
 *    PUPPETEER_SKIP_DOWNLOAD is not "true"). If it fails, the PDF above.
 */
@Injectable()
export class InvoicePdfService {
  private readonly logger = new Logger(InvoicePdfService.name);

  constructor(private readonly config: ConfigService) {}

  /** The rendered PDF. The caller sets the Content-Type. */
  async generate(input: InvoicePdfInput): Promise<Buffer> {
    const doc = buildInvoiceDocument(input);
    const qrUrl = input.invoice.fiscalQrUrl ?? null;
    if (this.shouldSkipPuppeteer()) {
      return renderPlainInvoicePdf(doc, qrUrl);
    }
    try {
      return await this.renderWithChromium(doc, qrUrl);
    } catch (err) {
      this.logger.warn(`Chromium render failed (${(err as Error).message}): using the plain PDF`);
      return renderPlainInvoicePdf(doc, qrUrl);
    }
  }

  private async renderWithChromium(doc: InvoiceDocument, qrUrl: string | null): Promise<Buffer> {
    const qrPngDataUrl = qrUrl
      ? await QRCode.toDataURL(qrUrl, { errorCorrectionLevel: "M", width: 220 })
      : undefined;
    const html = renderInvoiceHtml(doc, qrPngDataUrl);

    let browser: any = null;
    try {
      const puppeteer = (await import("puppeteer-core")).default;
      browser = await puppeteer.launch({
        headless: true,
        args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
        executablePath: this.config.get<string>("PUPPETEER_EXECUTABLE_PATH") || undefined,
        timeout: RENDER_TIMEOUT_MS,
      });
      const page = await browser.newPage();
      // Self-contained HTML (the QR is a data URL): nothing to wait for.
      await page.setContent(html, { waitUntil: "load", timeout: RENDER_TIMEOUT_MS });
      const pdf = await page.pdf({
        format: "A4",
        printBackground: true,
        displayHeaderFooter: true,
        headerTemplate: "<span></span>",
        footerTemplate:
          '<div style="font-size:7pt;color:#6b7280;width:100%;padding:0 12mm;text-align:right;font-family:sans-serif">' +
          'Página <span class="pageNumber"></span> de <span class="totalPages"></span></div>',
        margin: { top: "12mm", bottom: "16mm", left: "12mm", right: "12mm" },
        timeout: RENDER_TIMEOUT_MS,
      });
      return Buffer.from(pdf);
    } finally {
      if (browser) {
        await browser.close().catch(() => undefined);
      }
    }
  }

  private shouldSkipPuppeteer(): boolean {
    return (
      this.config.get<string>("PUPPETEER_SKIP_DOWNLOAD") === "true" ||
      !this.config.get<string>("PUPPETEER_EXECUTABLE_PATH")
    );
  }
}
