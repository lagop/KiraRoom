/**
 * CSV cells that a spreadsheet opens as plain data.
 *
 * A text cell that starts with =, +, -, @, a tab or a carriage return is read
 * by Excel, LibreOffice and Google Sheets as a formula (a client called
 * "=SUM(1)" shows 1). Following the OWASP "CSV injection" guidance, such a
 * cell gets a leading single quote, which makes it text, and is wrapped in
 * double quotes. Numbers are not touched: a refund of "-12,50" stays a number.
 *
 * Every CSV the backend writes goes through here: the invoice book
 * (accounting/invoice-book.service.ts) with csvTextCell / csvNumberCell, and
 * the Papa.unparse exports (exports/exports.service.ts) with
 * CSV_FORMULA_START as their escapeFormulae pattern (Papa applies it to
 * string values only, so number values stay numbers there too).
 */

/** The characters a spreadsheet reads as the start of a formula. */
export const CSV_FORMULA_START = /^[=+\-@\t\r]/;

/** A plain number, with a decimal point or comma: "-12,50", "21", "9.5". */
const PLAIN_NUMBER = /^-?\d+(?:[.,]\d+)?$/;

/** The text, with a leading quote when a spreadsheet would run it. */
export function neutralizeCsvFormula(text: string): string {
  return CSV_FORMULA_START.test(text) ? `'${text}` : text;
}

function quoteIfNeeded(text: string, delimiter: string, force: boolean): string {
  const needsQuotes = force || text.includes(delimiter) || /["\r\n]/.test(text);
  return needsQuotes ? `"${text.replace(/"/g, '""')}"` : text;
}

/** A text cell: names, notes, NIFs, statuses. */
export function csvTextCell(value: string | null | undefined, delimiter = ";"): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  const escaped = neutralizeCsvFormula(text);
  return quoteIfNeeded(escaped, delimiter, escaped !== text);
}

/**
 * A number cell, already formatted ("-12,50"). It is written as it is so a
 * spreadsheet reads it as a number. Anything that is not a plain number is
 * treated as text, so a wrong value can never reach the file as a formula.
 */
export function csvNumberCell(value: number | string, delimiter = ";"): string {
  const text = String(value);
  if (!PLAIN_NUMBER.test(text)) return csvTextCell(text, delimiter);
  return quoteIfNeeded(text, delimiter, false);
}
