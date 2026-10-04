import { BadRequestException } from "@nestjs/common";
import {
  MODELO_303_NOT_COVERED,
  MODELO_303_RATE_ROWS,
  MODELO_303_ZERO_RATE_KEY,
  aggregateModelo303,
} from "./modelo-303";

/**
 * Modelo 303 (IVA). The old aggregator put 21 % in 01-03 and 4 % in 07-09
 * (the AEAT form has them the other way round), called 36 the total devengado
 * (36-37 are intra-community purchase deductions) and 67 the result (it is
 * 71). These pin the layout of the AEAT's 2026 instructions and diseño de
 * registro: 4 % -> 01-03, 10 % -> 04-06, 21 % -> 07-09, rectifications in
 * 14-15, 27 = total devengado, 45 = total a deducir, 46 = 27 - 45,
 * 64 = 46 + 58 + 76, 66 = 64 x 65 %, 69 = 66 + 77 - 78 + 68 + 108,
 * 71 = 69 - 70 + 109 - 112.
 */

const line = (rate: number, baseCents: number, taxCents: number) => ({ rate, baseCents, taxCents });
const inv = (lines: unknown, series = "A", totalCents = 0) => ({ series, totalCents, taxBreakdown: lines });

describe("aggregateModelo303", () => {
  it("fills each rate's own row, with the form's tipo, and the totals", () => {
    const boxes = aggregateModelo303([
      inv([line(21, 10_000, 2_100)]),
      inv([line(21, 5_000, 1_050), line(10, 2_000, 200)]),
      inv([line(4, 1_000, 40)]),
    ]);

    expect([boxes["01"], boxes["02"], boxes["03"]]).toEqual([1_000, 4, 40]);
    expect([boxes["04"], boxes["05"], boxes["06"]]).toEqual([2_000, 10, 200]);
    expect([boxes["07"], boxes["08"], boxes["09"]]).toEqual([15_000, 21, 3_150]);

    expect(boxes["27"]).toBe(3_390); // 03+06+09 (+ the rest, all 0)
    expect(boxes["45"]).toBe(0); // purchases are not in KiraRoom
    expect(boxes["46"]).toBe(3_390);
    expect(boxes["64"]).toBe(3_390);
    expect(boxes["65"]).toBe(100); // territorio común
    expect(boxes["66"]).toBe(3_390);
    expect(boxes["69"]).toBe(3_390);
    expect(boxes["71"]).toBe(3_390);
  });

  it("does not use the old wrong boxes", () => {
    const boxes = aggregateModelo303([inv([line(21, 10_000, 2_100)])]);
    expect(boxes["01"]).toBe(0); // 01 is the 4 % base, not 21 %
    expect(boxes["36"]).toBe(0); // 36 is an intra-community deduction base
    expect(boxes["67"]).toBeUndefined(); // there is no box 67 in the 2026 form
  });

  it("puts rectifying invoices in 14-15, signed and not split by rate", () => {
    const boxes = aggregateModelo303([
      inv([line(21, 10_000, 2_100)], "A", 12_100),
      inv([line(21, -1_000, -210), line(10, -500, -50)], "R", -1_760),
      // A negative total outside series R is a rectification too, as in the invoice book.
      inv([line(10, -100, -10)], "B", -110),
    ]);

    expect(boxes["07"]).toBe(10_000);
    expect(boxes["04"]).toBe(0);
    expect(boxes["14"]).toBe(-1_600);
    expect(boxes["15"]).toBe(-270);
    expect(boxes["27"]).toBe(1_830); // 2_100 - 270
    expect(boxes["71"]).toBe(1_830);
  });

  it("keeps 0 % lines out of the boxes and reports their base apart", () => {
    const boxes = aggregateModelo303([inv([line(0, 3_000, 0), line(21, 1_000, 210)])]);
    // Tipo cero (150) or exempt: KiraRoom cannot tell, so neither is assumed.
    expect(boxes["150"]).toBe(0);
    expect(boxes[MODELO_303_ZERO_RATE_KEY]).toBe(3_000);
    expect(boxes["27"]).toBe(210);
  });

  it("compares rates to two decimals instead of rounding them", () => {
    // 4.5 % used to be rounded into the 4 % row (and 20.6 % into 21 %).
    expect(() => aggregateModelo303([inv([line(4.5, 1_000, 45)])])).toThrow(BadRequestException);
    expect(() => aggregateModelo303([inv([line(20.6, 1_000, 206)])])).toThrow(BadRequestException);
    // ...while float noise on a real rate still lands in its row.
    const boxes = aggregateModelo303([inv([line(21.000001, 1_000, 210)])]);
    expect(boxes["07"]).toBe(1_000);
  });

  it("refuses a rate the 2026 form has no row for, naming it", () => {
    expect(() => aggregateModelo303([inv([line(7, 1_000, 70), line(5, 100, 5)])])).toThrow(/5, 7 %/);
  });

  it("has a row for each of the three IVA rates", () => {
    expect(MODELO_303_RATE_ROWS.map((r) => [r.rate, ...r.boxes])).toEqual([
      [4, "01", "02", "03"],
      [10, "04", "05", "06"],
      [21, "07", "08", "09"],
    ]);
  });

  it("leaves at zero, and present, every box KiraRoom has no data for", () => {
    const boxes = aggregateModelo303([]);
    for (const box of MODELO_303_NOT_COVERED) expect(boxes[box]).toBe(0);
    expect(boxes["27"]).toBe(0);
    expect(boxes["71"]).toBe(0);
    // The tipo boxes are the form's constants even in an empty quarter.
    expect([boxes["02"], boxes["05"], boxes["08"]]).toEqual([4, 10, 21]);
  });

  it("ignores malformed breakdowns instead of failing the whole quarter", () => {
    const boxes = aggregateModelo303([inv(null), inv([line(21, 1_000, 210)])]);
    expect(boxes["09"]).toBe(210);
  });
});
