import { BadRequestException } from "@nestjs/common";

/**
 * Modelo 303: the quarterly IVA return (AEAT), régimen general.
 *
 * Box layout from the AEAT's own documents, downloaded from
 * sede.agenciatributaria.gob.es on 2026-10-02:
 *   - "Instrucciones 01-1T de 2026" and "Instrucciones 02 a 12 y 2T a 4T de
 *     2026" (procedure G414, Modelo 303 > Instrucciones 2026)
 *   - the diseño de registro DR303e26v101.xlsx (pages DP30301 and DP30303),
 *     which prints each total's formula.
 *
 *   IVA devengado
 *     150-152  tipo 0 %          01-03  4 %      04-06  10 %      07-09  21 %
 *     153-155, 165-167  rows whose tipo is the constant "00000" in the 2026
 *              diseño de registro: no rate is assigned to them this year
 *     10-11    intra-community acquisitions
 *     12-13    other reverse-charge operations
 *     14-15    modificación de bases y cuotas (art. 80 LIVA): signed, and
 *              not broken down by rate
 *     156-158, 168-170, 16-24  recargo de equivalencia; 25-26 its changes
 *     27       total cuota devengada = 152+167+03+155+06+09+11+13+15
 *                                      +158+170+18+21+24+26
 *   IVA deducible
 *     28-44    input tax: current and investment purchases, imports,
 *              intra-community, rectifications, REAGP, regularisations
 *     45       total a deducir = 29+31+33+35+37+39+41+42+43+44
 *     46       resultado régimen general = 27 - 45
 *   Resultado (page 3)
 *     58       resultado régimen simplificado (page 2)
 *     76       regularización art. 80.Cinco.5ª
 *     64       suma de resultados = 46 + 58 + 76
 *     65       % atribuible a la Administración del Estado (100 % unless
 *              the salon also files with a Diputación Foral or Navarra)
 *     66       atribuible a la Administración del Estado = 64 x 65 %
 *     77       import IVA liquidated by customs, pending
 *     110, 78, 87  quotas to compensate from earlier periods
 *              (pending, applied now, left for later = 110 - 78)
 *     68       annual regularisation (joint state / foral filers only)
 *     108      other adjustments of a rectifying return
 *     69       resultado = 66 + 77 - 78 + 68 + 108
 *     70, 109  only on a rectifying return
 *     112      fuel-depot payments on account (from period 02 / 2T 2026)
 *     71       resultado de la liquidación = 69 - 70 + 109 - 112
 *   Información adicional (page 3): 59, 60, 120, 122, 123, 124, 62-63, 74-75
 *
 * What KiraRoom knows is the salon's issued invoices, so it fills the 4 / 10
 * / 21 % devengado rows, puts rectifying invoices (series R, or a negative
 * total) in 14-15 as the instructions ask, and computes the totals with the
 * form's own formulas. Everything it has no data for stays at 0 and is listed
 * in MODELO_303_NOT_COVERED: input tax (28-45, the salon's purchases),
 * earlier-period compensations, the special regimes and the information
 * boxes. The draft assumes régimen general and territorio común (65 = 100).
 *
 * Invoice lines at 0 % are kept out of the boxes. KiraRoom cannot tell
 * whether they are tipo cero (box 150) or exempt / not subject (not part of
 * the devengado at all), so their base is returned apart, under
 * MODELO_303_ZERO_RATE_KEY, for the salon or its gestoría to place. Their
 * cuota is 0 either way, so the result does not depend on it.
 *
 * Amounts are in cents like every other report; the tipo boxes (02, 05, 08,
 * 151) are percentages; 65 is a percentage.
 */

/** The base / tipo / cuota rows of the IVA devengado that KiraRoom fills, by rate. */
export const MODELO_303_RATE_ROWS: ReadonlyArray<{
  rate: number;
  boxes: readonly [string, string, string];
}> = [
  { rate: 4, boxes: ["01", "02", "03"] },
  { rate: 10, boxes: ["04", "05", "06"] },
  { rate: 21, boxes: ["07", "08", "09"] },
];

/** Boxes KiraRoom cannot know from issued invoices; always 0 in the draft. */
export const MODELO_303_NOT_COVERED = [
  // devengado: tipo cero (see MODELO_303_ZERO_RATE_KEY), rows with no rate
  // in 2026, intra-community, reverse charge, recargo de equivalencia
  "150", "151", "152", "153", "154", "155", "165", "166", "167",
  "10", "11", "12", "13",
  "156", "157", "158", "168", "169", "170",
  "16", "17", "18", "19", "20", "21", "22", "23", "24", "25", "26",
  // deducible: the salon's purchases
  "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39",
  "40", "41", "42", "43", "44",
  // resultado
  "58", "76", "77", "110", "78", "87", "68", "108", "70", "109", "112",
  // información adicional
  "59", "60", "120", "122", "123", "124", "62", "63", "74", "75",
] as const;

/**
 * Not a box: the base of the quarter's 0 % invoice lines, which may be tipo
 * cero (box 150) or exempt, a call KiraRoom cannot make.
 */
export const MODELO_303_ZERO_RATE_KEY = "base_0_sin_clasificar";

interface BreakdownLine {
  rate: number;
  baseCents: number;
  taxCents: number;
}

export interface Modelo303Invoice {
  series?: string | null;
  totalCents?: number | null;
  taxBreakdown: unknown;
}

/** Rectifying invoices, by the same rule as the invoice book export. */
function isRectifying(inv: Modelo303Invoice): boolean {
  return inv.series === "R" || (inv.totalCents ?? 0) < 0;
}

/**
 * Aggregates the quarter's invoices into the Modelo 303 boxes.
 *
 * Rates are compared to two decimals, not rounded to whole numbers: a 4.5 %
 * line is not a 4 % line, and is refused rather than filed under the wrong
 * row. So is any rate the 2026 form has no row for (5 %, IGIC's 7 %...).
 */
export function aggregateModelo303(invoices: Modelo303Invoice[]): Record<string, number> {
  const byRate = new Map<number, { base: number; tax: number }>();
  let modBase = 0;
  let modTax = 0;
  let zeroBase = 0;
  const unexpected = new Set<number>();

  for (const inv of invoices) {
    const lines = Array.isArray(inv.taxBreakdown) ? (inv.taxBreakdown as BreakdownLine[]) : [];
    const rectifying = isRectifying(inv);
    for (const line of lines) {
      const rate = Math.round(Number(line.rate) * 100) / 100;
      if (!Number.isFinite(rate)) continue;
      const base = Number(line.baseCents) || 0;
      const tax = Number(line.taxCents) || 0;
      if (rate === 0) {
        zeroBase += base;
        continue;
      }
      if (!MODELO_303_RATE_ROWS.some((r) => r.rate === rate)) {
        unexpected.add(rate);
        continue;
      }
      if (rectifying) {
        // Instructions, boxes 14-15: modifications are not broken down by rate.
        modBase += base;
        modTax += tax;
        continue;
      }
      const bucket = byRate.get(rate) ?? { base: 0, tax: 0 };
      bucket.base += base;
      bucket.tax += tax;
      byRate.set(rate, bucket);
    }
  }

  if (unexpected.size > 0) {
    const list = [...unexpected].sort((a, b) => a - b).join(", ");
    throw new BadRequestException(
      `Este trimestre tiene facturas con IVA al ${list} %, y el modelo 303 de 2026 solo tiene filas ` +
        `para el 4, el 10 y el 21 % (y el 0 %). Revisa el tipo de esas facturas antes de generar el borrador.`,
    );
  }

  const boxes: Record<string, number> = {};
  for (const box of MODELO_303_NOT_COVERED) boxes[box] = 0;
  for (const { rate, boxes: [baseBox, rateBox, taxBox] } of MODELO_303_RATE_ROWS) {
    const bucket = byRate.get(rate) ?? { base: 0, tax: 0 };
    boxes[baseBox] = bucket.base;
    boxes[rateBox] = rate;
    boxes[taxBox] = bucket.tax;
  }
  boxes["14"] = modBase;
  boxes["15"] = modTax;

  boxes["27"] =
    boxes["152"] + boxes["167"] + boxes["03"] + boxes["155"] + boxes["06"] + boxes["09"] +
    boxes["11"] + boxes["13"] + boxes["15"] + boxes["158"] + boxes["170"] + boxes["18"] +
    boxes["21"] + boxes["24"] + boxes["26"];
  boxes["45"] =
    boxes["29"] + boxes["31"] + boxes["33"] + boxes["35"] + boxes["37"] + boxes["39"] +
    boxes["41"] + boxes["42"] + boxes["43"] + boxes["44"];
  boxes["46"] = boxes["27"] - boxes["45"];

  boxes["64"] = boxes["46"] + boxes["58"] + boxes["76"];
  boxes["65"] = 100;
  boxes["66"] = Math.round((boxes["64"] * boxes["65"]) / 100);
  boxes["69"] = boxes["66"] + boxes["77"] - boxes["78"] + boxes["68"] + boxes["108"];
  boxes["71"] = boxes["69"] - boxes["70"] + boxes["109"] - boxes["112"];

  boxes[MODELO_303_ZERO_RATE_KEY] = zeroBase;
  return boxes;
}
