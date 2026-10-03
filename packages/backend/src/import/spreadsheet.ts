import ExcelJS from "exceljs";

/**
 * Reading an .xlsx export as if it were the CSV.
 *
 * The importer only took CSV, so a salon whose previous program exports
 * Excel (or who keeps its clients in an Excel of its own) had to open it and
 * "save as CSV" first -- which on Windows also changes the encoding. The
 * first sheet is turned into exactly the rows the CSV path produces (header
 * text -> cell text), so columns.ts reads both the same way.
 *
 * Excel stores dates and times as numbers that ExcelJS hands over as Dates
 * (the wall-clock value, in UTC). They become the text the parsers already
 * understand: "2026-10-05", "10:30", or "2026-10-05 10:30" when the cell has
 * both -- and a duration formatted as a time ("1:30") reads as "01:30",
 * which parseDuration takes as 90 minutes.
 */

/** More rows than this is refused anyway (see ImportService); stop early. */
const MAX_ROWS = 5000;

export async function readXlsxRows(buffer: Buffer): Promise<Record<string, string>[]> {
  const wb = new ExcelJS.Workbook();
  try {
    // ExcelJS types its own "Buffer" (an ArrayBuffer); at runtime it unzips
    // a Node Buffer as is.
    await wb.xlsx.load(buffer as unknown as Parameters<typeof wb.xlsx.load>[0]);
  } catch {
    throw new SpreadsheetError(
      "No hemos podido leer el archivo Excel. Si es un .xls antiguo, ábrelo y guárdalo como .xlsx o como CSV.",
    );
  }
  const sheet = wb.worksheets[0];
  if (!sheet || sheet.actualRowCount === 0) return [];
  if (sheet.actualRowCount > MAX_ROWS + 1) {
    throw new SpreadsheetError("El archivo tiene más de 5.000 filas: divídelo en varios.");
  }

  // Header row: like the CSV parser, the first row names the columns. An
  // empty header leaves its column out; a repeated one gets "_1", "_2"
  // (what papaparse does), so the first of them is the one matched.
  const headers = new Map<number, string>();
  const used = new Map<string, number>();
  sheet.getRow(1).eachCell({ includeEmpty: false }, (c, col) => {
    const name = cellText(c.value).trim();
    if (!name) return;
    const n = used.get(name) ?? 0;
    used.set(name, n + 1);
    headers.set(col, n === 0 ? name : `${name}_${n}`);
  });

  const rows: Record<string, string>[] = [];
  sheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const out: Record<string, string> = {};
    for (const [col, name] of headers) out[name] = cellText(row.getCell(col).value).trim();
    if (Object.values(out).some((v) => v.length > 0)) rows.push(out);
  });
  return rows;
}

export class SpreadsheetError extends Error {}

/** One cell's value as the text a CSV export would have in that cell. */
export function cellText(v: ExcelJS.CellValue): string {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return dateText(v);
  if (typeof v === "number") {
    // Binary floats: 25.5 stays "25.5", 25.499999999999996 becomes "25.5".
    return String(Number(v.toFixed(10)));
  }
  if (typeof v === "string") return v;
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "object") {
    if ("richText" in v && Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
    if ("error" in v) return "";
    if ("formula" in v || "sharedFormula" in v) {
      return cellText((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    }
    if ("hyperlink" in v) {
      const text = (v as ExcelJS.CellHyperlinkValue).text as unknown;
      return typeof text === "string" ? text : cellText(text as ExcelJS.CellValue);
    }
  }
  return String(v);
}

function dateText(d: Date): string {
  if (Number.isNaN(d.getTime())) return "";
  // Excel's floats land a few ms off the minute ("10:29:59.999").
  const t = new Date(Math.round(d.getTime() / 60_000) * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  const time = `${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}`;
  // A time with no date sits on Excel's day zero (1899-12-30).
  if (t.getUTCFullYear() < 1900) return time;
  const day = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  return time === "00:00" ? day : `${day} ${time}`;
}
