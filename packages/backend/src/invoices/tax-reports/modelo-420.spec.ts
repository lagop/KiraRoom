import { BadRequestException } from "@nestjs/common";
import { MODELO_420_NOT_COVERED, MODELO_420_RATE_ROWS, aggregateModelo420 } from "./modelo-420";

/**
 * Modelo 420 (IGIC). Generating it used to be refused: nobody had the Agencia
 * Tributaria Canaria's box layout, and approximating it from the 303 would
 * have produced a wrong return someone might file. These pin the layout of
 * the ATC's official instructions: six base / tipo / cuota rows, 25 = total
 * devengado, 40 = total deducible, 41 = 25 - 40, 45 = 41 + 42 - 43 - 44.
 */

const line = (rate: number, baseCents: number, taxCents: number) => ({ rate, baseCents, taxCents });

describe("aggregateModelo420", () => {
  it("fills one row per rate, low to high, and the totals", () => {
    const boxes = aggregateModelo420([
      { taxBreakdown: [line(7, 10_000, 700)] },
      { taxBreakdown: [line(7, 5_000, 350), line(3, 2_000, 60)] },
      { taxBreakdown: [line(0, 1_500, 0)] },
    ]);

    // tipo cero first: it is one of the rows the form asks for.
    expect([boxes["01"], boxes["02"], boxes["03"]]).toEqual([1_500, 0, 0]);
    expect([boxes["04"], boxes["05"], boxes["06"]]).toEqual([2_000, 3, 60]);
    expect([boxes["07"], boxes["08"], boxes["09"]]).toEqual([15_000, 7, 1_050]);
    expect([boxes["10"], boxes["11"], boxes["12"]]).toEqual([0, 0, 0]);

    expect(boxes["25"]).toBe(1_110); // 03+06+09+12+15+18 (+20+22-24, all 0)
    expect(boxes["40"]).toBe(0); // purchases are not in KiraRoom
    expect(boxes["41"]).toBe(1_110);
    expect(boxes["45"]).toBe(1_110);
  });

  it("keeps 9.5 % as 9.5 %, not rounded to 10 % as the 303 does", () => {
    const boxes = aggregateModelo420([{ taxBreakdown: [line(9.5, 10_000, 950)] }]);
    expect([boxes["01"], boxes["02"], boxes["03"]]).toEqual([10_000, 9.5, 950]);
  });

  it("uses all six rows for the six IGIC rates", () => {
    const rates = [0, 3, 7, 9.5, 15, 20];
    const boxes = aggregateModelo420([{ taxBreakdown: rates.map((r) => line(r, 1_000, r * 10)) }]);
    expect(MODELO_420_RATE_ROWS.map(([, rateBox]) => boxes[rateBox])).toEqual(rates);
    expect(boxes["25"]).toBe(rates.reduce((s, r) => s + r * 10, 0));
  });

  it("refuses a quarter with more rates than the form has rows", () => {
    const rates = [0, 3, 5, 7, 9.5, 15, 20];
    expect(() => aggregateModelo420([{ taxBreakdown: rates.map((r) => line(r, 100, 1)) }])).toThrow(
      BadRequestException,
    );
  });

  it("leaves at zero, and present, every box KiraRoom has no data for", () => {
    const boxes = aggregateModelo420([]);
    for (const box of MODELO_420_NOT_COVERED) expect(boxes[box]).toBe(0);
    expect(boxes["25"]).toBe(0);
    expect(boxes["45"]).toBe(0);
  });

  it("ignores malformed breakdowns instead of failing the whole quarter", () => {
    const boxes = aggregateModelo420([{ taxBreakdown: null }, { taxBreakdown: [line(7, 1_000, 70)] }]);
    expect(boxes["03"]).toBe(70);
  });
});
