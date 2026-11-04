/**
 * The rows an import left out, as a CSV the salon can fix and upload again:
 * the file's own columns, then "Fila" and "Errores".
 */
export type ImportRowErrorLike = {
  row: number;
  fields: Array<{ col: string; msg: string }>;
  data?: Record<string, unknown>;
};

/** "Teléfono: no es un número válido; Email: ..." */
export function errorReasons(e: ImportRowErrorLike): string {
  return e.fields.map((f) => `${f.col}: ${f.msg}`).join("; ");
}

/**
 * One CSV cell. A value starting with =, +, - or @ is read as a formula by
 * Excel, so it gets a leading apostrophe; quotes are doubled.
 */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",;\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function errorRowsCsv(errors: ImportRowErrorLike[]): string {
  const columns: string[] = [];
  for (const e of errors) {
    for (const key of Object.keys(e.data ?? {})) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  const header = [...columns, "Fila", "Errores"];
  const lines = [header.map(csvCell).join(",")];
  for (const e of [...errors].sort((a, b) => a.row - b.row)) {
    const data = e.data ?? {};
    lines.push([...columns.map((c) => csvCell(data[c])), csvCell(e.row), csvCell(errorReasons(e))].join(","));
  }
  // BOM so Excel opens the accents correctly.
  return "\uFEFF" + lines.join("\r\n");
}
