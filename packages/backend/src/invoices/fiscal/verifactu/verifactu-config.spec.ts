import { readFileSync } from "fs";
import { join } from "path";
import { PRODUCER, producer, verifactuAvailable } from "./config";
import { fiscalSubmissionAvailable } from "../fiscal-availability";

describe("VERI*FACTU configuration", () => {
  it("the producer in every record is the one /legal/verifactu declares (KIRAROOM_OWNER)", () => {
    const legal = readFileSync(join(__dirname, "../../../../../frontend/lib/salon-legal.ts"), "utf8");
    const owner = /export const KIRAROOM_OWNER = \{([\s\S]*?)\} as const/.exec(legal)![1];
    expect(/name: "([^"]+)"/.exec(owner)![1]).toBe(PRODUCER.name);
    expect(/nif: "([^"]+)"/.exec(owner)![1]).toBe(PRODUCER.nif);
    expect(producer()).toEqual(PRODUCER);
  });

  it("in production nothing is available without the explicit flag", () => {
    const production = { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv;
    expect(verifactuAvailable(production)).toBe(false);
    expect(fiscalSubmissionAvailable(production)).toBe(false);
    expect(verifactuAvailable({ ...production, FISCAL_SUBMISSION_ENABLED: "0" })).toBe(false);
    expect(verifactuAvailable({ ...production, FISCAL_SUBMISSION_ENABLED: "1" })).toBe(true);
  });
});
