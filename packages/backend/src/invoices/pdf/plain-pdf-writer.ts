import * as QRCode from "qrcode";
import type { InvoiceDocument } from "./invoice-document";

/**
 * A plain PDF of an invoice, written by hand: the renderer used when
 * Chromium is not available (local development, CI, a Chromium that fails
 * to start). It used to print a few lines of Courier, with the amounts as
 * "30" and accents broken; it now lays the same content model as the HTML
 * template (invoice-document.ts) out on A4:
 *
 *  - Helvetica / Helvetica-Bold (two of the 14 standard PDF fonts, nothing
 *    embedded) with WinAnsiEncoding, so ñ, á, é, ¿ and € print as such;
 *  - the lines table flows onto as many pages as it needs, its header
 *    repeated, with "Página n de N" at the foot;
 *  - the fiscal QR, when there is one, drawn as vector squares.
 *
 * Uncompressed on purpose: small anyway, and the tests read the text back.
 */

const PAGE_W = 595.28;
const PAGE_H = 841.89;
const MARGIN = 42;
const CONTENT_W = PAGE_W - 2 * MARGIN;
const FOOTER_H = 30;

const PURPLE = "0.30 0.11 0.58";
const GREY = "0.29 0.33 0.39";
const LIGHT = "0.90 0.91 0.92";
const BLACK = "0.07 0.07 0.07";

type Font = "F1" | "F2"; // Helvetica, Helvetica-Bold

/** Helvetica advance widths (1/1000 em) for ASCII; others from their base letter. */
const HELVETICA: Record<string, number> = (() => {
  const w: Record<string, number> = {};
  const set = (chars: string, width: number) => {
    for (const c of chars) w[c] = width;
  };
  set(" !,./:;I[\\]ft", 278);
  set("0123456789$#?_abdeghnopqu€", 556);
  set("\"", 355);
  set("%", 889);
  set("&ABEKPSVXY", 667);
  set("'", 191);
  set("()-`r", 333);
  set("*", 389);
  set("+<=>~", 584);
  set("@", 1015);
  set("CDHNRUw", 722);
  set("FTZ", 611);
  set("GOQ", 778);
  set("J", 500);
  set("L", 556);
  set("M", 833);
  set("W", 944);
  set("^", 469);
  set("ckSsvxyz", 500);
  set("ijl", 222);
  set("m", 833);
  set("{}", 334);
  set("|", 260);
  // Overrides for letters listed twice above.
  w.S = 667;
  w.k = 500;
  w.t = 278;
  w["\u00a0"] = 278;
  w["¿"] = 611; // ¿
  w["¡"] = 333; // ¡
  w["º"] = 365; // º
  w["ª"] = 370; // ª
  w["·"] = 278; // ·
  return w;
})();

/** Helvetica-Bold advance widths where they differ from Helvetica's. */
const HELVETICA_BOLD: Record<string, number> = (() => {
  const w: Record<string, number> = { ...HELVETICA };
  const set = (chars: string, width: number) => {
    for (const c of chars) w[c] = width;
  };
  set("ABCDHKNRUw", 722);
  set("EPSVXY", 667);
  set("FLTZ", 611);
  set("J", 556);
  set("bdghnopqu", 611);
  set("cksxyv", 556);
  set("ijl", 278);
  set("ft", 333);
  set("r", 389);
  set("m", 889);
  set("w", 778);
  set("z", 500);
  set("\"", 474);
  set("'", 238);
  set("!", 333);
  set(":;", 333);
  return w;
})();

/** WinAnsiEncoding codes of the characters outside Latin-1 it has. */
const WIN_ANSI_EXTRA: Record<string, number> = {
  "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85,
  "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a,
  "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e, "‘": 0x91, "’": 0x92,
  "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97,
  "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c,
  "ž": 0x9e, "Ÿ": 0x9f,
};

function baseLetter(ch: string): string {
  return ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "") || ch;
}

/** The text as WinAnsi bytes (one char per byte, latin1), unknown characters approximated. */
export function toWinAnsi(text: string): string {
  let out = "";
  for (const ch of String(text)) {
    const code = ch.codePointAt(0)!;
    if (ch === "\u202f" || ch === "\u2009" || ch === "\u2007") out += " ";
    else if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) out += ch;
    else if (WIN_ANSI_EXTRA[ch] !== undefined) out += String.fromCharCode(WIN_ANSI_EXTRA[ch]);
    else if (code === 0x09 || code === 0x0a || code === 0x0d) out += " ";
    else {
      const base = baseLetter(ch);
      out += base.length === 1 && base.charCodeAt(0) < 0x7f ? base : "?";
    }
  }
  return out;
}

function charWidth(ch: string, font: Font): number {
  const table = font === "F2" ? HELVETICA_BOLD : HELVETICA;
  return table[ch] ?? table[baseLetter(ch)] ?? 556;
}

export function textWidth(text: string, size: number, font: Font = "F1"): number {
  let units = 0;
  for (const ch of String(text)) units += charWidth(ch, font);
  return (units / 1000) * size;
}

function pdfString(text: string): string {
  return `(${toWinAnsi(text).replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)")})`;
}

/** Splits `text` into lines no wider than `width`, breaking long words too. */
export function wrapText(text: string, width: number, size: number, font: Font = "F1"): string[] {
  const out: string[] = [];
  for (const paragraph of String(text).split(/\r?\n/)) {
    let line = "";
    for (const word of paragraph.split(/\s+/).filter(Boolean)) {
      const candidate = line ? `${line} ${word}` : word;
      if (textWidth(candidate, size, font) <= width) {
        line = candidate;
        continue;
      }
      if (line) out.push(line);
      // A word wider than the column on its own: cut it.
      let rest = word;
      while (textWidth(rest, size, font) > width) {
        let n = rest.length - 1;
        while (n > 1 && textWidth(rest.slice(0, n), size, font) > width) n--;
        out.push(rest.slice(0, n));
        rest = rest.slice(n);
      }
      line = rest;
    }
    out.push(line);
  }
  return out.length ? out : [""];
}

class Pages {
  readonly pages: string[][] = [];
  y = 0;

  constructor(private readonly onNewPage: (p: Pages) => void) {
    this.addPage();
  }

  private get ops(): string[] {
    return this.pages[this.pages.length - 1];
  }

  addPage(): void {
    this.pages.push([]);
    this.y = PAGE_H - MARGIN;
    this.onNewPage(this);
  }

  /** Room for `height` more points on this page, or a new page. */
  ensure(height: number): void {
    if (this.y - height < MARGIN + FOOTER_H) this.addPage();
  }

  text(x: number, y: number, text: string, size: number, font: Font = "F1", color = BLACK): void {
    if (!text) return;
    this.ops.push(`BT ${color} rg /${font} ${size} Tf 1 0 0 1 ${x.toFixed(2)} ${y.toFixed(2)} Tm ${pdfString(text)} Tj ET`);
  }

  right(xRight: number, y: number, text: string, size: number, font: Font = "F1", color = BLACK): void {
    this.text(xRight - textWidth(text, size, font), y, text, size, font, color);
  }

  line(x1: number, y1: number, x2: number, y2: number, width = 0.5, color = LIGHT): void {
    this.ops.push(`${color} RG ${width} w ${x1.toFixed(2)} ${y1.toFixed(2)} m ${x2.toFixed(2)} ${y2.toFixed(2)} l S`);
  }

  rect(x: number, y: number, w: number, h: number, fill: string, stroke?: string): void {
    this.ops.push(
      `${fill} rg ${stroke ? `${stroke} RG 0.6 w ` : ""}${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re ${stroke ? "B" : "f"}`,
    );
  }

  raw(op: string): void {
    this.ops.push(op);
  }
}

/** Columns of the lines table: right edges of the numeric ones. */
const COL = {
  desc: MARGIN + 4,
  descWidth: CONTENT_W * 0.5 - 8,
  qty: MARGIN + CONTENT_W * 0.6,
  price: MARGIN + CONTENT_W * 0.75,
  tax: MARGIN + CONTENT_W * 0.86,
  total: MARGIN + CONTENT_W - 4,
};

function drawLinesHeader(p: Pages, taxLabel: string): void {
  const y = p.y - 12;
  p.text(COL.desc, y, "DESCRIPCIÓN", 8, "F2", PURPLE);
  p.right(COL.qty, y, "CANT.", 8, "F2", PURPLE);
  p.right(COL.price, y, "PRECIO UNIT.", 8, "F2", PURPLE);
  p.right(COL.tax, y, taxLabel.toUpperCase(), 8, "F2", PURPLE);
  p.right(COL.total, y, "TOTAL", 8, "F2", PURPLE);
  p.line(MARGIN, y - 5, MARGIN + CONTENT_W, y - 5, 1.2, PURPLE);
  p.y = y - 9;
}

function drawQr(p: Pages, url: string, x: number, y: number, size: number): void {
  const qr = QRCode.create(url, { errorCorrectionLevel: "M" });
  const n = qr.modules.size;
  const cell = size / n;
  const ops: string[] = [`${BLACK} rg`];
  for (let r = 0; r < n; r++) {
    for (let c = 0; c < n; c++) {
      if (qr.modules.data[r * n + c]) {
        ops.push(`${(x + c * cell).toFixed(2)} ${(y + size - (r + 1) * cell).toFixed(2)} ${cell.toFixed(3)} ${cell.toFixed(3)} re`);
      }
    }
  }
  ops.push("f");
  p.raw(ops.join("\n"));
}

/** Renders the invoice to PDF bytes. */
export function renderPlainInvoicePdf(doc: InvoiceDocument, qrUrl?: string | null): Buffer {
  let inLinesTable = false;
  const pages = new Pages((p) => {
    if (p.pages.length === 1) return;
    // A continuation page: whose invoice it is, and the table header again.
    p.text(MARGIN, p.y - 10, `${doc.title} ${doc.fullNumber} (continuación)`, 9, "F2", GREY);
    p.y -= 22;
    if (inLinesTable) drawLinesHeader(p, doc.taxLabel);
  });

  // ---- Header: salon, title, number, date ----
  const top = pages.y;
  wrapText(doc.issuer.name, CONTENT_W * 0.5, 14, "F2").slice(0, 2).forEach((l, i) => {
    pages.text(MARGIN, top - 16 - i * 17, l, 14, "F2");
  });
  pages.right(MARGIN + CONTENT_W, top - 18, doc.title, 18, "F2", PURPLE);
  pages.right(MARGIN + CONTENT_W, top - 36, `Número: ${doc.fullNumber} (serie ${doc.series})`, 10, "F1", GREY);
  pages.right(MARGIN + CONTENT_W, top - 50, `Fecha de expedición: ${doc.issueDate}`, 10, "F1", GREY);
  let headerBottom = top - 58;
  if (doc.cancelled) {
    pages.right(MARGIN + CONTENT_W, top - 66, "ANULADA", 11, "F2", "0.73 0.11 0.11");
    headerBottom = top - 72;
  }
  pages.y = headerBottom - 10;

  // ---- Issuer and recipient ----
  const colW = (CONTENT_W - 16) / 2;
  const partyLines = (party: { name: string; details: string[] }) => [
    ...wrapText(party.name, colW - 20, 10.5, "F2").map((t) => ({ t, bold: true })),
    ...party.details.flatMap((d) => wrapText(d, colW - 20, 9)).map((t) => ({ t, bold: false })),
  ];
  const issuer = partyLines(doc.issuer);
  const recipient = partyLines(doc.recipient);
  const rows = Math.max(issuer.length, recipient.length);
  const boxH = 26 + rows * 12.5;
  pages.ensure(boxH + 10);
  const boxTop = pages.y;
  for (const [i, [heading, lines]] of ([["EMISOR", issuer], ["CLIENTE", recipient]] as const).entries()) {
    const x = MARGIN + i * (colW + 16);
    pages.rect(x, boxTop - boxH, colW, boxH, "1 1 1", LIGHT);
    pages.text(x + 10, boxTop - 15, heading, 8, "F2", PURPLE);
    lines.forEach((l, j) => {
      pages.text(x + 10, boxTop - 29 - j * 12.5, l.t, l.bold ? 10.5 : 9, l.bold ? "F2" : "F1", l.bold ? BLACK : GREY);
    });
  }
  pages.y = boxTop - boxH - 14;

  // ---- What it rectifies ----
  if (doc.rectification) {
    const r = doc.rectification;
    const texts = [
      `Rectifica a la factura: ${r.original ?? "—"}${r.originalDate ? ` de fecha ${r.originalDate}` : ""}`,
      ...(r.reason ? wrapText(`Motivo: ${r.reason}`, CONTENT_W - 20, 9.5) : []),
    ];
    const h = 12 + texts.length * 13;
    pages.ensure(h + 10);
    pages.rect(MARGIN, pages.y - h, CONTENT_W, h, "1 0.98 0.92", "0.99 0.83 0.30");
    texts.forEach((t, i) => pages.text(MARGIN + 10, pages.y - 15 - i * 13, t, 9.5, i === 0 ? "F2" : "F1"));
    pages.y -= h + 14;
  }

  // ---- Lines ----
  pages.ensure(60);
  drawLinesHeader(pages, doc.taxLabel);
  inLinesTable = true;
  for (const l of doc.lines) {
    const descLines = wrapText(l.description, COL.descWidth, 9.5);
    if (l.discount) descLines.push(l.discount);
    const h = 8 + descLines.length * 12;
    pages.ensure(h);
    const y = pages.y - 12;
    descLines.forEach((t, i) => {
      const isDiscount = !!l.discount && i === descLines.length - 1;
      pages.text(COL.desc, y - i * 12, t, isDiscount ? 8.5 : 9.5, "F1", isDiscount ? GREY : BLACK);
    });
    pages.right(COL.qty, y, l.quantity, 9.5);
    pages.right(COL.price, y, l.unitPrice, 9.5);
    pages.right(COL.tax, y, l.taxRate, 9.5);
    pages.right(COL.total, y, l.total, 9.5);
    pages.y -= h;
    pages.line(MARGIN, pages.y, MARGIN + CONTENT_W, pages.y);
  }
  inLinesTable = false;
  pages.y -= 16;

  // ---- Tax breakdown (left) and totals (right), kept together ----
  const breakdownH = 22 + doc.taxBreakdown.length * 15;
  const totalsH = 18 + (doc.totals.taxes.length + 1) * 15 + 6;
  pages.ensure(Math.max(breakdownH, totalsH) + 10);
  const blockTop = pages.y;
  const bx = { label: MARGIN + 4, base: MARGIN + 190, rate: MARGIN + 240, tax: MARGIN + 310 };
  pages.text(bx.label, blockTop - 10, "IMPUESTO", 8, "F2", PURPLE);
  pages.right(bx.base, blockTop - 10, "BASE IMPONIBLE", 8, "F2", PURPLE);
  pages.right(bx.rate, blockTop - 10, "TIPO", 8, "F2", PURPLE);
  pages.right(bx.tax, blockTop - 10, "CUOTA", 8, "F2", PURPLE);
  pages.line(MARGIN, blockTop - 15, bx.tax + 4, blockTop - 15, 1.2, PURPLE);
  doc.taxBreakdown.forEach((t, i) => {
    const y = blockTop - 29 - i * 15;
    pages.text(bx.label, y, t.label, 9.5);
    pages.right(bx.base, y, t.base, 9.5);
    pages.right(bx.rate, y, t.rate, 9.5);
    pages.right(bx.tax, y, t.tax, 9.5);
  });

  const tx = { label: MARGIN + CONTENT_W - 110, value: MARGIN + CONTENT_W - 4 };
  let ty = blockTop - 10;
  pages.right(tx.label, ty, "Base imponible", 9.5, "F1", GREY);
  pages.right(tx.value, ty, doc.totals.base, 9.5);
  for (const t of doc.totals.taxes) {
    ty -= 15;
    pages.right(tx.label, ty, t.label, 9.5, "F1", GREY);
    pages.right(tx.value, ty, t.amount, 9.5);
  }
  ty -= 10;
  pages.line(tx.label - 70, ty, tx.value + 4, ty, 1.5, PURPLE);
  ty -= 16;
  pages.right(tx.label, ty, "Total", 12, "F2", PURPLE);
  pages.right(tx.value, ty, doc.totals.total, 12, "F2", PURPLE);
  pages.y = Math.min(ty, blockTop - breakdownH) - 20;

  // ---- Fiscal reference and QR ----
  const fiscal = [
    doc.fiscal.reference ? `Referencia fiscal: ${doc.fiscal.reference}` : "",
    doc.fiscal.hash ? `Huella: ${doc.fiscal.hash}` : "",
  ].filter(Boolean);
  const qrSize = qrUrl ? 90 : 0;
  if (fiscal.length || qrUrl) {
    const fiscalLines = fiscal.flatMap((f) => wrapText(f, CONTENT_W - qrSize - 20, 7.5));
    pages.ensure(Math.max(qrSize, fiscalLines.length * 10) + 6);
    fiscalLines.forEach((t, i) => pages.text(MARGIN, pages.y - 10 - i * 10, t, 7.5, "F1", GREY));
    if (qrUrl) drawQr(pages, qrUrl, MARGIN + CONTENT_W - qrSize, pages.y - qrSize, qrSize);
  }

  return writePdf(pages.pages, doc);
}

function writePdf(pageOps: string[][], doc: InvoiceDocument): Buffer {
  const total = pageOps.length;
  // Object ids: 1 catalog, 2 pages, 3-4 fonts, 5 info, then content + page per page.
  const contentId = (i: number) => 6 + i * 2;
  const pageId = (i: number) => 7 + i * 2;
  const objects: string[] = [];
  objects[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objects[2] = `<< /Type /Pages /Kids [${pageOps.map((_, i) => `${pageId(i)} 0 R`).join(" ")}] /Count ${total} >>`;
  objects[3] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
  objects[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";
  objects[5] = `<< /Title ${pdfString(`${doc.title} ${doc.fullNumber}`)} /Producer (KiraRoom) >>`;
  pageOps.forEach((ops, i) => {
    const footer = `BT ${GREY} rg /F1 8 Tf 1 0 0 1 ${(MARGIN + CONTENT_W - textWidth(`Página ${i + 1} de ${total}`, 8)).toFixed(2)} ${(MARGIN - 6).toFixed(2)} Tm ${pdfString(`Página ${i + 1} de ${total}`)} Tj ET`;
    const left = `BT ${GREY} rg /F1 8 Tf 1 0 0 1 ${MARGIN} ${(MARGIN - 6).toFixed(2)} Tm ${pdfString(`${doc.title} ${doc.fullNumber}`)} Tj ET`;
    const stream = [...ops, left, footer].join("\n") + "\n";
    objects[contentId(i)] = `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\nstream\n${stream}endstream`;
    objects[pageId(i)] =
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] ` +
      `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentId(i)} 0 R >>`;
  });

  let out = "%PDF-1.4\n%\xe2\xe3\xcf\xd3\n";
  const offsets: number[] = [];
  for (let id = 1; id < objects.length; id++) {
    offsets[id] = Buffer.byteLength(out, "latin1");
    out += `${id} 0 obj\n${objects[id]}\nendobj\n`;
  }
  const xrefAt = Buffer.byteLength(out, "latin1");
  out += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  for (let id = 1; id < objects.length; id++) {
    out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
  }
  out += `trailer\n<< /Size ${objects.length} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xrefAt}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}
