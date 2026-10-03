/**
 * How the panel shows a Modelo 303 draft: the box numbers and words of the
 * AEAT's 2026 form, so the salon or its gestoría can copy them into Pre303.
 * Computed by the server (tax-reports/modelo-303.ts).
 */
import { euros } from "./modelo-420";

export interface Modelo303Row {
  box: string;
  label: string;
  /** Formatted value, ready to show. */
  value: string;
}

const RATE_ROWS: Array<[string, string, string]> = [
  ["01", "02", "03"],
  ["04", "05", "06"],
  ["07", "08", "09"],
];

/** Not a box: base of the quarter's 0 % lines (tipo cero or exempt). Same key as the server. */
export const ZERO_RATE_KEY = "base_0_sin_clasificar";

/** One line per rate the quarter used, the rectifications, then the totals the form asks for. */
export function modelo303Rows(boxes: Record<string, number>): {
  rates: Array<{ boxes: string; rate: string; base: string; cuota: string }>;
  totals: Modelo303Row[];
  zeroRateBase: string | null;
} {
  const rates = RATE_ROWS.filter(([base, , cuota]) => (boxes[base] ?? 0) !== 0 || (boxes[cuota] ?? 0) !== 0).map(
    ([base, rate, cuota]) => ({
      boxes: `${base} · ${rate} · ${cuota}`,
      rate: `${boxes[rate] ?? 0} %`,
      base: euros(boxes[base] ?? 0),
      cuota: euros(boxes[cuota] ?? 0),
    }),
  );
  if ((boxes["14"] ?? 0) !== 0 || (boxes["15"] ?? 0) !== 0) {
    rates.push({
      boxes: "14 · 15",
      rate: "Rectificativas",
      base: euros(boxes["14"] ?? 0),
      cuota: euros(boxes["15"] ?? 0),
    });
  }
  const totals: Modelo303Row[] = [
    { box: "27", label: "Total cuota devengada", value: euros(boxes["27"] ?? 0) },
    { box: "45", label: "Total a deducir", value: euros(boxes["45"] ?? 0) },
    { box: "46", label: "Resultado régimen general (27 − 45)", value: euros(boxes["46"] ?? 0) },
    { box: "71", label: "Resultado de la liquidación", value: euros(boxes["71"] ?? 0) },
  ];
  const zero = boxes[ZERO_RATE_KEY] ?? 0;
  return { rates, totals, zeroRateBase: zero !== 0 ? euros(zero) : null };
}

/** When the 303 of a quarter is due (AEAT instructions: days 1-20 of the next month; 4T from 1 to 30 January). */
export function modelo303Deadline(year: number, quarter: number): string {
  if (quarter === 4) return `del 1 al 30 de enero de ${year + 1}`;
  const month = ["abril", "julio", "octubre"][quarter - 1];
  return `del 1 al 20 de ${month} de ${year}`;
}
