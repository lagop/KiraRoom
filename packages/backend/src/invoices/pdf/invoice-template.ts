/**
 * HTML template for the AEAT-style invoice PDF.
 *
 * Original layout for KiraStudio. Renders an A4 page with the tenant
 * logo top-left, fiscal header, lines table, tax breakdown, totals
 * block, and a QR code at the bottom-right that links to the
 * Verifactu verifier.
 *
 * Not a reproduction of any third-party template.
 */

import { InvoiceLine } from "./invoice-pdf.service";

export interface InvoiceTemplateData {
  tenant: {
    name: string;
    taxId?: string | null;
    legalName?: string | null;
    address?: {
      street?: string;
      city?: string;
      state?: string;
      postalCode?: string;
      country?: string;
    } | null;
    logo?: string | null;
    email?: string | null;
    phone?: string | null;
  };
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
  qrPngDataUrl?: string;
}

function fmt(cents: number, currency: string): string {
  return (cents / 100).toLocaleString("es-ES", {
    style: "currency",
    currency: currency || "EUR",
  });
}

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Build a self-contained HTML document. The QR is passed as a
 * base64 data URL (the renderer doesn't run an HTTP server to fetch
 * the image).
 */
export function buildInvoiceHtml(data: InvoiceTemplateData): string {
  const linesHtml = data.lines
    .map(
      (l) => `
        <tr>
          <td class="desc">${escapeHtml(l.description)}</td>
          <td class="qty">${escapeHtml(String(l.quantity))}</td>
          <td class="price">${fmt(l.unitPriceCents * (1 - (l.discountPct ?? 0) / 100), data.invoice.currency)}</td>
          <td class="tax">${escapeHtml(String(l.taxRate))}%</td>
          <td class="total">${fmt(l.totalCents, data.invoice.currency)}</td>
        </tr>`,
    )
    .join("");

  const taxRows = data.taxBreakdown
    .map(
      (t) => `
        <tr>
          <td>${t.rate}%</td>
          <td class="num">${fmt(t.baseCents, data.invoice.currency)}</td>
          <td class="num">${fmt(t.taxCents, data.invoice.currency)}</td>
        </tr>`,
    )
    .join("");

  const addr = data.tenant.address;
  const addrHtml = addr
    ? [
        addr.street,
        [addr.postalCode, addr.city, addr.state].filter(Boolean).join(" "),
        addr.country,
      ]
        .filter(Boolean)
        .map((line) => `<div>${escapeHtml(line)}</div>`)
        .join("")
    : "";

  const logoHtml = data.tenant.logo
    ? `<img class="logo" src="${escapeHtml(data.tenant.logo)}" alt="${escapeHtml(data.tenant.name)}" />`
    : `<div class="logo-text">${escapeHtml(data.tenant.name)}</div>`;

  const qrImg = data.qrPngDataUrl
    ? `<img class="qr" src="${data.qrPngDataUrl}" alt="QR fiscal" />`
    : "";

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <title>Factura ${escapeHtml(data.invoice.series)}${escapeHtml(data.invoice.number)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      color: #111;
      margin: 0;
      padding: 24px 32px;
      font-size: 11pt;
    }
    header { display: flex; align-items: flex-start; gap: 24px; margin-bottom: 24px; }
    header .logo,
    header .logo-text { width: 160px; height: 60px; object-fit: contain; font-weight: 700; font-size: 16pt; }
    header .meta { flex: 1; text-align: right; }
    header .meta h1 { font-size: 22pt; margin: 0 0 4px 0; color: #4c1d95; }
    header .meta p { margin: 1px 0; color: #555; font-size: 9pt; }
    section.parties { display: flex; gap: 24px; margin-bottom: 18px; }
    section.parties .party { flex: 1; border: 1px solid #e5e7eb; border-radius: 6px; padding: 12px; }
    section.parties .party h2 {
      font-size: 9pt; text-transform: uppercase; color: #6b21a8;
      margin: 0 0 6px 0; letter-spacing: 0.5px;
    }
    section.parties .party .name { font-weight: 600; font-size: 11pt; margin-bottom: 2px; }
    section.parties .party .meta { font-size: 9pt; color: #4b5563; }
    table.lines { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
    table.lines th {
      text-align: left; padding: 8px 6px; font-size: 9pt; text-transform: uppercase;
      color: #6b21a8; border-bottom: 2px solid #6b21a8;
    }
    table.lines th.qty, table.lines th.price, table.lines th.tax, table.lines th.total { text-align: right; }
    table.lines td { padding: 8px 6px; border-bottom: 1px solid #f1f1f4; }
    table.lines td.qty, table.lines td.price, table.lines td.tax, table.lines td.total { text-align: right; font-variant-numeric: tabular-nums; }
    table.totals { width: 100%; border-collapse: collapse; margin-bottom: 18px; }
    table.totals td { padding: 5px 8px; }
    table.totals td.label { text-align: right; color: #4b5563; }
    table.totals td.num { text-align: right; font-variant-numeric: tabular-nums; }
    table.totals tr.total td { border-top: 2px solid #4c1d95; font-weight: 700; font-size: 13pt; color: #4c1d95; padding-top: 10px; }
    footer { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 32px; }
    footer .fiscal {
      font-size: 8pt; color: #6b7280; max-width: 60%;
    }
    footer .fiscal code { font-size: 8pt; background: #f3f4f6; padding: 1px 4px; border-radius: 3px; }
    footer .qr-wrap { width: 110px; height: 110px; }
    footer .qr { width: 110px; height: 110px; }
  </style>
</head>
<body>
  <header>
    <div class="logo-wrap">${logoHtml}</div>
    <div class="meta">
      <h1>Factura ${escapeHtml(data.invoice.series)}${escapeHtml(data.invoice.number)}</h1>
      <p>Fecha: ${escapeHtml(data.invoice.issueDate)}</p>
      <p>Moneda: ${escapeHtml(data.invoice.currency)}</p>
      ${data.invoice.fiscalReference ? `<p>CSV: <code>${escapeHtml(data.invoice.fiscalReference)}</code></p>` : ""}
    </div>
  </header>

  <section class="parties">
    <div class="party">
      <h2>Emisor</h2>
      <div class="name">${escapeHtml(data.tenant.legalName ?? data.tenant.name)}</div>
      ${data.tenant.taxId ? `<div class="meta">NIF: ${escapeHtml(data.tenant.taxId)}</div>` : ""}
      ${addrHtml}
      ${data.tenant.email ? `<div class="meta">${escapeHtml(data.tenant.email)}</div>` : ""}
      ${data.tenant.phone ? `<div class="meta">${escapeHtml(data.tenant.phone)}</div>` : ""}
    </div>
    <div class="party">
      <h2>Cliente</h2>
      <div class="name">${escapeHtml(data.invoice.recipientName)}</div>
      ${data.invoice.recipientTaxId ? `<div class="meta">NIF: ${escapeHtml(data.invoice.recipientTaxId)}</div>` : ""}
    </div>
  </section>

  <table class="lines">
    <thead>
      <tr>
        <th>Descripción</th>
        <th class="qty">Cant.</th>
        <th class="price">P. unit.</th>
        <th class="tax">IVA</th>
        <th class="total">Total</th>
      </tr>
    </thead>
    <tbody>${linesHtml}</tbody>
  </table>

  <table class="totals">
    <tbody>
      <tr><td class="label">Subtotal</td><td class="num">${fmt(data.invoice.subtotalCents, data.invoice.currency)}</td></tr>
      ${data.taxBreakdown
        .map(
          (t) =>
            `<tr><td class="label">IVA ${t.rate}%</td><td class="num">${fmt(t.taxCents, data.invoice.currency)}</td></tr>`,
        )
        .join("")}
      <tr class="total"><td class="label">Total</td><td class="num">${fmt(data.invoice.totalCents, data.invoice.currency)}</td></tr>
    </tbody>
  </table>

  ${taxRows ? `<table class="lines"><thead><tr><th>Tipo</th><th class="qty">Base</th><th class="qty">Cuota</th></tr></thead><tbody>${taxRows}</tbody></table>` : ""}

  <footer>
    <div class="fiscal">
      ${data.invoice.fiscalHash ? `<div>Huella SHA-256: <code>${escapeHtml(data.invoice.fiscalHash)}</code></div>` : ""}
      <div style="margin-top:6px">Documento emitido por KiraStudio SaaS.</div>
    </div>
    <div class="qr-wrap">${qrImg}</div>
  </footer>
</body>
</html>`;
}
