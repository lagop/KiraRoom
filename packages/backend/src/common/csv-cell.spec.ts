import * as Papa from "papaparse";
import { CSV_FORMULA_START, csvNumberCell, csvTextCell, neutralizeCsvFormula } from "./csv-cell";

/**
 * Every CSV the backend writes is opened by a salon or its gestoría in a
 * spreadsheet, and text cells come from people outside the salon (the public
 * booking form). A text cell must never be run as a formula.
 */

describe("csvTextCell", () => {
  it.each(["=SUM(1)", "+SUM(1)", "-SUM(1)", "@SUM(1)", "\tSUM(1)", "\rSUM(1)"])(
    "puts a quote before %p and wraps it in double quotes",
    (value) => {
      expect(csvTextCell(value)).toBe(`"'${value}"`);
    },
  );

  it("leaves ordinary text alone", () => {
    expect(csvTextCell("Ana García")).toBe("Ana García");
    expect(csvTextCell("a=b")).toBe("a=b");
    expect(csvTextCell("")).toBe("");
    expect(csvTextCell(null)).toBe("");
    expect(csvTextCell(undefined)).toBe("");
  });

  it("quotes the delimiter, quotes and line breaks", () => {
    expect(csvTextCell('Peluquería; "SL"')).toBe('"Peluquería; ""SL"""');
    expect(csvTextCell("dos\nlíneas")).toBe('"dos\nlíneas"');
    expect(csvTextCell("a,b", ",")).toBe('"a,b"');
    expect(csvTextCell("a,b", ";")).toBe("a,b");
  });

  it("escapes the double quotes of an escaped cell too", () => {
    expect(csvTextCell('=SUM("1")')).toBe(`"'=SUM(""1"")"`);
  });

  it("a negative-looking text cell is still text", () => {
    expect(csvTextCell("-5")).toBe(`"'-5"`);
  });
});

describe("csvNumberCell", () => {
  it("writes numbers as they are, negative ones too", () => {
    expect(csvNumberCell("-12,50")).toBe("-12,50");
    expect(csvNumberCell("0,00")).toBe("0,00");
    expect(csvNumberCell("9,5")).toBe("9,5");
    expect(csvNumberCell(21)).toBe("21");
    expect(csvNumberCell(-3.5)).toBe("-3.5");
  });

  it("quotes a decimal comma when the delimiter is a comma", () => {
    expect(csvNumberCell("-12,50", ",")).toBe('"-12,50"');
  });

  it("anything that is not a plain number is treated as text", () => {
    expect(csvNumberCell("-1+1")).toBe(`"'-1+1"`);
    expect(csvNumberCell("=1")).toBe(`"'=1"`);
    expect(csvNumberCell("NaN")).toBe("NaN");
  });
});

describe("neutralizeCsvFormula", () => {
  it("only prefixes the formula starts", () => {
    expect(neutralizeCsvFormula("=1")).toBe("'=1");
    expect(neutralizeCsvFormula("1=1")).toBe("1=1");
  });
});

describe("CSV_FORMULA_START with Papa.unparse (the exports)", () => {
  it("escapes string cells and leaves number cells, negative ones too", () => {
    const csv = Papa.unparse([{ name: "=SUM(1)", phone: "+34 600", amount: -1250, note: "ok" }], {
      escapeFormulae: CSV_FORMULA_START,
      header: false,
    });
    expect(csv).toBe(`"'=SUM(1)","'+34 600",-1250,ok`);
  });
});
