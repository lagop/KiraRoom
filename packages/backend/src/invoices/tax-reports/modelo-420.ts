import { BadRequestException } from "@nestjs/common";

/**
 * Modelo 420: the quarterly IGIC return (Agencia Tributaria Canaria).
 *
 * Box layout from the ATC's official instructions for the form ("Normas para
 * cumplimentar el modelo", section 7, Liquidación), downloaded from
 * gobiernodecanarias.org/tributos on 2026-10-02:
 *
 *   IGIC devengado
 *     01-03, 04-06, 07-09, 10-12, 13-15, 16-18  six rows of base / tipo / cuota,
 *         one per rate applied, tipo cero included. The rate is written by the
 *         filer, not printed on the form.
 *     19-20  reverse charge (art. 19.1.2º Ley 20/1991)
 *     21-22  rectifications of earlier periods
 *     23-24  travellers' refunds (subtracted)
 *     25     total devengado = 03+06+09+12+15+18+20+22-24
 *   IGIC deducible
 *     26-39  input tax: current purchases, investment goods, imports,
 *            rectifications, agriculture compensations, regularisations
 *     40     total deducible = 27+29+31+33+35+36+37+38+39
 *   Resultado
 *     41     25 - 40
 *     42     unpaid-operation adjustment (art. 22.8.5ª)
 *     43     quotas from earlier periods pending compensation
 *     44     only for a complementary return
 *     45     resultado = 41 + 42 - 43 - 44
 *
 * What KiraRoom knows is the salon's issued invoices, so it fills the
 * devengado rows and leaves at zero what it has no data for: input tax
 * (26-40, the salon's purchases), earlier-period compensations (43) and the
 * special cases (19-24, 42, 44, 46, 47). The draft says so; the salon or its
 * gestoría completes those before filing.
 *
 * Amounts are in cents like every other report; the tipo boxes (02, 05...)
 * are percentages (7, 9.5...).
 */

/** The six base / tipo / cuota rows of the IGIC devengado section. */
export const MODELO_420_RATE_ROWS: ReadonlyArray<readonly [string, string, string]> = [
  ["01", "02", "03"],
  ["04", "05", "06"],
  ["07", "08", "09"],
  ["10", "11", "12"],
  ["13", "14", "15"],
  ["16", "17", "18"],
];

/** Boxes KiraRoom cannot know from issued invoices; always 0 in the draft. */
export const MODELO_420_NOT_COVERED = [
  "19", "20", "21", "22", "23", "24",
  "26", "27", "28", "29", "30", "31", "32", "33", "34", "35", "36", "37", "38", "39",
  "42", "43", "44", "46", "47",
] as const;

interface BreakdownLine {
  rate: number;
  baseCents: number;
  taxCents: number;
}

/**
 * Aggregates the quarter's invoices into the Modelo 420 boxes.
 *
 * Rates are kept to two decimals: IGIC has 9.5 %, which the Modelo 303's
 * whole-number bucketing would have turned into 10 %.
 */
export function aggregateModelo420(invoices: Array<{ taxBreakdown: unknown }>): Record<string, number> {
  const byRate = new Map<number, { base: number; tax: number }>();
  for (const inv of invoices) {
    const lines = Array.isArray(inv.taxBreakdown) ? (inv.taxBreakdown as BreakdownLine[]) : [];
    for (const line of lines) {
      const rate = Math.round(Number(line.rate) * 100) / 100;
      if (!Number.isFinite(rate)) continue;
      const bucket = byRate.get(rate) ?? { base: 0, tax: 0 };
      bucket.base += Number(line.baseCents) || 0;
      bucket.tax += Number(line.taxCents) || 0;
      byRate.set(rate, bucket);
    }
  }

  const rates = [...byRate.keys()].sort((a, b) => a - b);
  if (rates.length > MODELO_420_RATE_ROWS.length) {
    throw new BadRequestException(
      `Este trimestre tiene facturas a ${rates.length} tipos de IGIC distintos (${rates.join(", ")} %) ` +
        `y el modelo 420 solo tiene ${MODELO_420_RATE_ROWS.length} filas. Revisa los tipos aplicados.`,
    );
  }

  const boxes: Record<string, number> = {};
  for (const row of MODELO_420_RATE_ROWS) for (const box of row) boxes[box] = 0;
  rates.forEach((rate, i) => {
    const [baseBox, rateBox, taxBox] = MODELO_420_RATE_ROWS[i];
    const bucket = byRate.get(rate)!;
    boxes[baseBox] = bucket.base;
    boxes[rateBox] = rate;
    boxes[taxBox] = bucket.tax;
  });
  for (const box of MODELO_420_NOT_COVERED) boxes[box] = 0;

  const devengado =
    MODELO_420_RATE_ROWS.reduce((sum, [, , taxBox]) => sum + boxes[taxBox], 0) +
    boxes["20"] +
    boxes["22"] -
    boxes["24"];
  const deducible =
    boxes["27"] + boxes["29"] + boxes["31"] + boxes["33"] + boxes["35"] +
    boxes["36"] + boxes["37"] + boxes["38"] + boxes["39"];

  boxes["25"] = devengado;
  boxes["40"] = deducible;
  boxes["41"] = devengado - deducible;
  boxes["45"] = boxes["41"] + boxes["42"] - boxes["43"] - boxes["44"];
  return boxes;
}
