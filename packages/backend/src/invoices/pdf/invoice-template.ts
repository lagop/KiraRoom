/**
 * HTML template for the invoice PDF, printed by Chromium (puppeteer-core).
 *
 * Original layout for KiraRoom: an A4 page with the salon's name, the
 * document title and number, issuer and recipient, the lines, the tax
 * breakdown per rate, the totals and, when the invoice has one, the fiscal
 * QR. Everything it prints comes from the content model
 * (invoice-document.ts), which is where the legal minimum is decided; this
 * file only lays it out. Long invoices flow onto more pages with the table
 * header repeated.
 *
 * Not a reproduction of any third-party template.
 */

import { buildInvoiceDocument, InvoiceDocument, InvoicePdfInput } from "./invoice-document";

export type InvoiceTemplateData = InvoicePdfInput & { qrPngDataUrl?: string };

function escapeHtml(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function party(heading: string, p: { name: string; details: string[] }): string {
  return `
    <div class="party">
      <h2>${escapeHtml(heading)}</h2>
      <div class="name">${escapeHtml(p.name)}</div>
      ${p.details.map((d) => `<div class="meta">${escapeHtml(d)}</div>`).join("")}
    </div>`;
}

/** Build a self-contained HTML document (the QR comes in as a data URL). */
export function buildInvoiceHtml(data: InvoiceTemplateData): string {
  return renderInvoiceHtml(buildInvoiceDocument(data), data.qrPngDataUrl);
}

export function renderInvoiceHtml(doc: InvoiceDocument, qrPngDataUrl?: string): string {
  const taxLabel = escapeHtml(doc.taxLabel);
  const linesHtml = doc.lines
    .map(
      (l) => `
        <tr>
          <td class="desc">${escapeHtml(l.description)}${l.discount ? `<div class="discount">${escapeHtml(l.discount)}</div>` : ""}</td>
          <td class="qty">${escapeHtml(l.quantity)}</td>
          <td class="price">${escapeHtml(l.unitPrice)}</td>
          <td class="tax">${escapeHtml(l.taxRate)}</td>
          <td class="total">${escapeHtml(l.total)}</td>
        </tr>`,
    )
    .join("");

  const breakdownRows = doc.taxBreakdown
    .map(
      (t) => `
        <tr>
          <td>${escapeHtml(t.label)}</td>
          <td class="num">${escapeHtml(t.base)}</td>
          <td class="num">${escapeHtml(t.rate)}</td>
          <td class="num">${escapeHtml(t.tax)}</td>
        </tr>`,
    )
    .join("");

  const rect = doc.rectification;
  const rectHtml = rect
    ? `
  <section class="rectification">
    <div><strong>Rectifica a la factura:</strong> ${escapeHtml(rect.original ?? "—")}${rect.originalDate ? ` de fecha ${escapeHtml(rect.originalDate)}` : ""}</div>
    ${rect.reason ? `<div><strong>Motivo:</strong> ${escapeHtml(rect.reason)}</div>` : ""}
  </section>`
    : "";

  const qrImg = qrPngDataUrl ? `<img class="qr" src="${qrPngDataUrl}" alt="QR fiscal" />` : "";

  return `<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8" />
  <title>${escapeHtml(doc.title)} ${escapeHtml(doc.fullNumber)}</title>
  <style>
    * { box-sizing: border-box; }
    body {
      font-family: "Liberation Sans", "DejaVu Sans", Arial, Helvetica, sans-serif;
      color: #111;
      margin: 0;
      padding: 0;
      font-size: 10.5pt;
    }
    header { display: flex; align-items: flex-start; gap: 24px; margin-bottom: 20px; }
    header .brand { flex: 1; font-weight: 700; font-size: 15pt; }
    header .meta { text-align: right; }
    header .meta h1 { font-size: 20pt; margin: 0 0 4px 0; color: #4c1d95; }
    header .meta p { margin: 1px 0; color: #374151; font-size: 10pt; }
    .cancelled { color: #b91c1c; font-weight: 700; }
    section.parties { display: flex; gap: 16px; margin-bottom: 16px; }
    section.parties .party { flex: 1; border: 1px solid #e5e7eb; border-radius: 6px; padding: 10px 12px; }
    section.parties .party h2 {
      font-size: 8.5pt; text-transform: uppercase; color: #6b21a8;
      margin: 0 0 6px 0; letter-spacing: 0.5px;
    }
    section.parties .party .name { font-weight: 600; font-size: 11pt; margin-bottom: 2px; }
    section.parties .party .meta { font-size: 9pt; color: #4b5563; }
    section.rectification { border: 1px solid #fcd34d; background: #fffbeb; border-radius: 6px; padding: 8px 12px; margin-bottom: 16px; font-size: 9.5pt; }
    table { width: 100%; border-collapse: collapse; }
    thead { display: table-header-group; }
    tr { page-break-inside: avoid; break-inside: avoid; }
    table.lines { margin-bottom: 16px; }
    table.lines th, table.breakdown th {
      text-align: left; padding: 6px; font-size: 8.5pt; text-transform: uppercase;
      color: #6b21a8; border-bottom: 2px solid #6b21a8;
    }
    table.lines th.qty, table.lines th.price, table.lines th.tax, table.lines th.total,
    table.breakdown th.num { text-align: right; }
    table.lines td { padding: 6px; border-bottom: 1px solid #f1f1f4; vertical-align: top; }
    table.lines td.qty, table.lines td.price, table.lines td.tax, table.lines td.total,
    table.breakdown td.num, table.totals td.num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
    .discount { font-size: 8.5pt; color: #555; }
    .bottom { display: flex; gap: 24px; align-items: flex-start; break-inside: avoid; }
    .bottom .left { flex: 1; }
    table.breakdown td { padding: 5px 6px; border-bottom: 1px solid #f1f1f4; }
    table.totals { width: 260px; }
    table.totals td { padding: 4px 6px; }
    table.totals td.label { text-align: right; color: #4b5563; }
    table.totals tr.total td { border-top: 2px solid #4c1d95; font-weight: 700; font-size: 12.5pt; color: #4c1d95; padding-top: 8px; }
    footer { display: flex; justify-content: space-between; align-items: flex-end; margin-top: 24px; break-inside: avoid; }
    footer .fiscal { font-size: 8pt; color: #6b7280; max-width: 70%; word-break: break-all; }
    footer .qr { width: 110px; height: 110px; }
  </style>
</head>
<body>
  <header>
    <div class="brand">${escapeHtml(doc.issuer.name)}</div>
    <div class="meta">
      <h1>${escapeHtml(doc.title)}</h1>
      <p>Número: <strong>${escapeHtml(doc.fullNumber)}</strong> (serie ${escapeHtml(doc.series)})</p>
      <p>Fecha de expedición: ${escapeHtml(doc.issueDate)}</p>
      ${doc.cancelled ? `<p class="cancelled">ANULADA</p>` : ""}
    </div>
  </header>

  <section class="parties">
    ${party("Emisor", doc.issuer)}
    ${party("Cliente", doc.recipient)}
  </section>
  ${rectHtml}

  <table class="lines">
    <thead>
      <tr>
        <th>Descripción</th>
        <th class="qty">Cant.</th>
        <th class="price">Precio unit.</th>
        <th class="tax">${taxLabel}</th>
        <th class="total">Total</th>
      </tr>
    </thead>
    <tbody>${linesHtml}</tbody>
  </table>

  <div class="bottom">
    <div class="left">
      <table class="breakdown">
        <thead><tr><th>Impuesto</th><th class="num">Base imponible</th><th class="num">Tipo</th><th class="num">Cuota</th></tr></thead>
        <tbody>${breakdownRows}</tbody>
      </table>
    </div>
    <table class="totals">
      <tbody>
        <tr><td class="label">Base imponible</td><td class="num">${escapeHtml(doc.totals.base)}</td></tr>
        ${doc.totals.taxes
          .map((t) => `<tr><td class="label">${escapeHtml(t.label)}</td><td class="num">${escapeHtml(t.amount)}</td></tr>`)
          .join("")}
        <tr class="total"><td class="label">Total</td><td class="num">${escapeHtml(doc.totals.total)}</td></tr>
      </tbody>
    </table>
  </div>

  <footer>
    <div class="fiscal">
      ${doc.fiscal.reference ? `<div>Referencia fiscal: <code>${escapeHtml(doc.fiscal.reference)}</code></div>` : ""}
      ${doc.fiscal.hash ? `<div>Huella: <code>${escapeHtml(doc.fiscal.hash)}</code></div>` : ""}
    </div>
    <div>${qrImg}</div>
  </footer>
</body>
</html>`;
}
