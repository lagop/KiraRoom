import ExcelJS from "exceljs";
import { Readable } from "stream";
import { inflateRawSync } from "zlib";

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
 *
 * Memory (O2). An .xlsx is a zip, and `wb.xlsx.load` unzipped all of it in
 * memory before anything was counted: a 0.5 MB file whose cells unpack to
 * hundreds of MB took the backend to 1.6 GB, and at the 3.5 MB allowed
 * Node ran out of heap, for every salon. Now:
 *   1. the zip is checked first (checkZip): every entry is inflated with a
 *      hard output cap, so an entry over MAX_ENTRY_BYTES or a total over
 *      MAX_TOTAL_BYTES refuses the file whatever its headers claim;
 *   2. the sheet is read with ExcelJS's streaming reader, row by row,
 *      stopping past MAX_ROWS;
 *   3. every cell is cut to MAX_CELL_CHARS.
 */

/** More rows than this is refused anyway (see ImportService); stop early. */
const MAX_ROWS = 5000;
/** One file inside the .xlsx, uncompressed. */
export const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
/** All of them together, uncompressed. */
export const MAX_TOTAL_BYTES = 50 * 1024 * 1024;
/** A cell's text past this is cut (a name, a phone or a note never needs more). */
export const MAX_CELL_CHARS = 1000;
/** A real export has a few dozen files inside; thousands is not a spreadsheet. */
const MAX_ENTRIES = 2000;

const TOO_BIG =
  "El archivo Excel es demasiado grande por dentro para leerlo. Divídelo en varios o guárdalo como CSV.";
const UNREADABLE =
  "No hemos podido leer el archivo Excel. Si es un .xls antiguo, ábrelo y guárdalo como .xlsx o como CSV.";

export async function readXlsxRows(buffer: Buffer): Promise<Record<string, string>[]> {
  const entries = checkZip(buffer);

  // The streaming reader needs the shared strings, styles and workbook
  // before the sheets. When a sheet comes first in the zip (ExcelJS itself
  // writes them so) it parks it in a temporary file and, intermittently,
  // reads it back with its text cells unresolved. So the sheets go last.
  const reader = new ExcelJS.stream.xlsx.WorkbookReader(Readable.from([sheetsLast(buffer, entries)]), {
    sharedStrings: "cache",
    // Styles tell a date cell from a number (its format).
    styles: "cache",
    hyperlinks: "ignore",
    worksheets: "emit",
    entries: "emit",
  });
  // ExcelJS (4.4) reads the sheet names from xl/workbook.xml and fails on a
  // sheet seen before it. The names are not needed here: an empty model
  // until it is read.
  const r = reader as unknown as { model?: unknown };
  if (!r.model) r.model = {};

  const headers = new Map<number, string>();
  const rows: Record<string, string>[] = [];
  let seenHeader = false;
  let sheets = 0;
  try {
    // Only the first sheet is read. The others are let through (the zip
    // check bounds them): leaving the reader half-way makes it fail.
    for await (const worksheet of reader) {
      const first = sheets++ === 0;
      for await (const row of worksheet as unknown as AsyncIterable<ExcelJS.Row>) {
        if (!first) continue;
        if (!seenHeader) {
          seenHeader = true;
          // Header row: like the CSV parser, the first row names the columns.
          // An empty header leaves its column out; a repeated one gets "_1",
          // "_2" (what papaparse does), so the first of them is the one matched.
          const used = new Map<string, number>();
          row.eachCell({ includeEmpty: false }, (c, col) => {
            const name = cellText(c.value).trim();
            if (!name) return;
            const n = used.get(name) ?? 0;
            used.set(name, n + 1);
            headers.set(col, n === 0 ? name : `${name}_${n}`);
          });
          continue;
        }
        const out: Record<string, string> = {};
        for (const [col, name] of headers) out[name] = cellText(row.getCell(col).value).trim();
        if (!Object.values(out).some((v) => v.length > 0)) continue;
        rows.push(out);
        if (rows.length > MAX_ROWS) {
          throw new SpreadsheetError("El archivo tiene más de 5.000 filas: divídelo en varios.");
        }
      }
    }
  } catch (err) {
    if (err instanceof SpreadsheetError) throw err;
    throw new SpreadsheetError(UNREADABLE);
  }
  return rows;
}

export class SpreadsheetError extends Error {}

/**
 * Walks the zip's central directory and inflates every entry with a hard
 * cap on its output, without keeping it: refuses the file when an entry
 * unpacks past MAX_ENTRY_BYTES or all of them past MAX_TOTAL_BYTES. The
 * sizes the headers declare are checked first (cheap), and the real ones
 * after, since a crafted file can declare anything.
 */
export function checkZip(buffer: Buffer): ZipEntry[] {
  const eocd = findEndOfCentralDirectory(buffer);
  if (eocd < 0) throw new SpreadsheetError(UNREADABLE);
  const count = buffer.readUInt16LE(eocd + 10);
  const cdOffset = buffer.readUInt32LE(eocd + 16);
  // ZIP64 markers: no export of a salon's clients needs a 4 GB zip.
  if (count === 0xffff || cdOffset === 0xffffffff) throw new SpreadsheetError(TOO_BIG);
  if (count > MAX_ENTRIES) throw new SpreadsheetError(TOO_BIG);

  const entries: ZipEntry[] = [];
  let declaredTotal = 0;
  let realTotal = 0;
  let p = cdOffset;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buffer.length || buffer.readUInt32LE(p) !== 0x02014b50) throw new SpreadsheetError(UNREADABLE);
    const centralStart = p;
    const flags = buffer.readUInt16LE(p + 8);
    const method = buffer.readUInt16LE(p + 10);
    const compressedSize = buffer.readUInt32LE(p + 20);
    const declared = buffer.readUInt32LE(p + 24);
    const nameLength = buffer.readUInt16LE(p + 28);
    const extraLength = buffer.readUInt16LE(p + 30);
    const commentLength = buffer.readUInt16LE(p + 32);
    const localOffset = buffer.readUInt32LE(p + 42);
    p += 46 + nameLength + extraLength + commentLength;
    const name = buffer.toString("utf8", centralStart + 46, centralStart + 46 + nameLength);

    if (compressedSize === 0xffffffff || declared === 0xffffffff || localOffset === 0xffffffff) {
      throw new SpreadsheetError(TOO_BIG);
    }
    declaredTotal += declared;
    if (declared > MAX_ENTRY_BYTES || declaredTotal > MAX_TOTAL_BYTES) throw new SpreadsheetError(TOO_BIG);

    // The entry's data follows its local header (whose name and extra
    // lengths may differ from the central directory's).
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new SpreadsheetError(UNREADABLE);
    }
    const dataStart =
      localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(dataStart, dataStart + compressedSize);
    let real: number;
    if (method === 0) {
      real = data.length;
    } else if (method === 8) {
      const cap = Math.min(MAX_ENTRY_BYTES, MAX_TOTAL_BYTES - realTotal);
      try {
        // One byte over the cap is enough to know it is too big.
        real = inflateRawSync(data, { maxOutputLength: cap + 1 }).length;
      } catch (err) {
        if ((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" || err instanceof RangeError) {
          throw new SpreadsheetError(TOO_BIG);
        }
        throw new SpreadsheetError(UNREADABLE);
      }
    } else {
      throw new SpreadsheetError(UNREADABLE);
    }
    realTotal += real;
    if (real > MAX_ENTRY_BYTES || realTotal > MAX_TOTAL_BYTES) throw new SpreadsheetError(TOO_BIG);

    // Where the entry ends: after its data, and its data descriptor when
    // the flags say one follows (with or without its signature).
    let localEnd = dataStart + compressedSize;
    if (flags & 0x08) localEnd += buffer.readUInt32LE(localEnd) === 0x08074b50 ? 16 : 12;
    if (localEnd > buffer.length) throw new SpreadsheetError(UNREADABLE);
    entries.push({ name, local: buffer.subarray(localOffset, localEnd), central: buffer.subarray(centralStart, p) });
  }
  return entries;
}

interface ZipEntry {
  name: string;
  /** Local header, data and data descriptor, as in the file. */
  local: Buffer;
  /** The central directory record. */
  central: Buffer;
}

/** The same zip with the worksheets after every other entry (see readXlsxRows). */
function sheetsLast(buffer: Buffer, entries: ZipEntry[]): Buffer {
  const isSheet = (e: ZipEntry) => /^xl\/worksheets\/sheet\d+\.xml$/.test(e.name);
  if (entries.length === 0) return buffer;
  const ordered = [...entries.filter((e) => !isSheet(e)), ...entries.filter(isSheet)];
  const parts: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of ordered) {
    parts.push(e.local);
    const central = Buffer.from(e.central);
    central.writeUInt32LE(offset, 42);
    centrals.push(central);
    offset += e.local.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(ordered.length, 8);
  end.writeUInt16LE(ordered.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  // The record is 22 bytes plus a comment of up to 65535.
  const stop = Math.max(0, buffer.length - 22 - 0xffff);
  for (let i = buffer.length - 22; i >= stop; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) return i;
  }
  return -1;
}

/** One cell's value as the text a CSV export would have in that cell, cut to MAX_CELL_CHARS. */
export function cellText(v: ExcelJS.CellValue): string {
  const text = rawCellText(v);
  return text.length > MAX_CELL_CHARS ? text.slice(0, MAX_CELL_CHARS) : text;
}

function rawCellText(v: ExcelJS.CellValue): string {
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
      return rawCellText((v as ExcelJS.CellFormulaValue).result as ExcelJS.CellValue);
    }
    if ("hyperlink" in v) {
      const text = (v as ExcelJS.CellHyperlinkValue).text as unknown;
      return typeof text === "string" ? text : rawCellText(text as ExcelJS.CellValue);
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
