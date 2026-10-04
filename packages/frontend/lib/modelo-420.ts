/**
 * How the panel shows a Modelo 420 draft: the box numbers and words of the
 * Agencia Tributaria Canaria's form, so the salon or its gestoría can copy
 * them into the ATC's program. Computed by the server (tax-reports/modelo-420.ts).
 */

export interface Modelo420Row {
  box: string;
  label: string;
  /** Formatted value, ready to show. */
  value: string;
}

const RATE_ROWS: Array<[string, string, string]> = [
  ["01", "02", "03"],
  ["04", "05", "06"],
  ["07", "08", "09"],
  ["10", "11", "12"],
  ["13", "14", "15"],
  ["16", "17", "18"],
];

export function euros(cents: number): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency: "EUR" }).format((cents ?? 0) / 100);
}

/** One line per rate the quarter used, then the totals the form asks for. */
export function modelo420Rows(boxes: Record<string, number>): {
  rates: Array<{ boxes: string; rate: string; base: string; cuota: string }>;
  totals: Modelo420Row[];
} {
  const rates = RATE_ROWS.filter(([base, , cuota]) => (boxes[base] ?? 0) !== 0 || (boxes[cuota] ?? 0) !== 0).map(
    ([base, rate, cuota]) => ({
      boxes: `${base} · ${rate} · ${cuota}`,
      rate: `${String(boxes[rate] ?? 0).replace(".", ",")} %`,
      base: euros(boxes[base] ?? 0),
      cuota: euros(boxes[cuota] ?? 0),
    }),
  );
  const totals: Modelo420Row[] = [
    { box: "25", label: "Total cuotas devengadas", value: euros(boxes["25"] ?? 0) },
    { box: "40", label: "Total cuotas deducibles", value: euros(boxes["40"] ?? 0) },
    { box: "41", label: "Diferencia (25 − 40)", value: euros(boxes["41"] ?? 0) },
    { box: "45", label: "Resultado (41 + 42 − 43 − 44)", value: euros(boxes["45"] ?? 0) },
  ];
  return { rates, totals };
}

/** The last quarter that has ended: the one being declared now. */
export function lastClosedQuarter(now = new Date()): { year: number; quarter: number } {
  const current = Math.floor(now.getMonth() / 3) + 1;
  return current === 1 ? { year: now.getFullYear() - 1, quarter: 4 } : { year: now.getFullYear(), quarter: current - 1 };
}

/** When the 420 of a quarter is due (ATC instructions: days 1-20 of the next month; Q4 during January). */
export function modelo420Deadline(year: number, quarter: number): string {
  if (quarter === 4) return `durante el mes de enero de ${year + 1}`;
  const month = ["abril", "julio", "octubre"][quarter - 1];
  return `del 1 al 20 de ${month} de ${year}`;
}
