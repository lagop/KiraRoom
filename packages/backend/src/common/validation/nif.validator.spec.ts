import { validateNif, NifValidation } from "./nif.validator";

/**
 * CIF checksum helper for tests: the control for a 7-digit body, as a
 * digit and as a letter (J for 0, A for 1 ... I for 9). Mirrors the
 * production implementation in nif.validator.ts.
 */
function cifControl(body: string): { digit: string; letter: string } {
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const digit = parseInt(body[i], 10);
    const weight = i % 2 === 0 ? 2 : 1;
    const product = digit * weight;
    sum += product < 10 ? product : Math.floor(product / 10) + (product % 10);
  }
  const controlDigit = (10 - (sum % 10)) % 10;
  return { digit: String(controlDigit), letter: "JABCDEFGHI"[controlDigit] };
}

function makeCif(letter: string, body = "1234567", form: "digit" | "letter" = "digit"): string {
  return `${letter}${body}${cifControl(body)[form]}`;
}

describe("validateNif (Spanish tax ID validation)", () => {
  it("accepts a valid 8-digit NIF and verifies the letter checksum", () => {
    // Real example: 12345678Z — 12345678 % 23 = 14 → NIF_LETTERS[14] = 'Z' ✓
    const r = validateNif("12345678Z");
    expect(r.valid).toBe(true);
    expect(r.type).toBe("nif");
    expect(r.normalized).toBe("12345678Z");
  });

  it("rejects an NIF with wrong checksum", () => {
    // 12345678A is invalid (correct is Z)
    const r = validateNif("12345678A");
    expect(r.valid).toBe(false);
    expect(r.error).toBe("nif-checksum");
  });

  it("normalizes whitespace, dots, and dashes", () => {
    expect(validateNif("12.345.678-Z").valid).toBe(true);
    expect(validateNif(" 12345678Z ").valid).toBe(true);
  });

  it("accepts an NIE (X/Y/Z prefix) with correct checksum", () => {
    // Z1234567R: Z→2, numeric=21234567, 21234567%23=21 → R ✓
    const r = validateNif("Z1234567R");
    expect(r.valid).toBe(true);
    expect(r.type).toBe("nie");
  });

  it("rejects NIE with wrong checksum", () => {
    // X1234567F: 1234567 % 23 = 19 → NIF_LETTERS[19] = "L" (actually valid).
    // Use a clearly-wrong letter so this isn't an off-by-one. X1234567Z would
    // be valid (23 % 23 = 0 → T), so we'll take the letter at index 5 (F).
    const r = validateNif("X1234567F");
    expect(r.valid).toBe(false);
    expect(r.error).toBe("nie-checksum");
  });

  // ---------- CIF ----------

  it("computes the control as the AEAT does (worked example)", () => {
    // 1234567: 2+2+6+4+(1+0)+6+(1+4) = 26 → (10 - 6) % 10 = 4 → digit 4, letter D.
    expect(cifControl("1234567")).toEqual({ digit: "4", letter: "D" });
    expect(validateNif("A12345674").valid).toBe(true);
    expect(validateNif("P1234567D").valid).toBe(true);
  });

  it("accepts real, published CIFs", () => {
    // Telefónica, S.A. (control 5) and the Agencia Tributaria (control H).
    // The old checksum rounded the sum up before taking mod 10, so it always
    // came out 0 / J and refused both.
    expect(validateNif("A28015865")).toMatchObject({ valid: true, type: "cif" });
    expect(validateNif("Q2826000H")).toMatchObject({ valid: true, type: "cif" });
  });

  it("A, B, E, H take a digit only", () => {
    for (const l of ["A", "B", "E", "H"]) {
      const ok = validateNif(makeCif(l, "1234567", "digit"));
      expect([l, ok.valid, ok.type]).toEqual([l, true, "cif"]);
      const wrong = validateNif(makeCif(l, "1234567", "letter"));
      expect([l, wrong.valid, wrong.error]).toEqual([l, false, "cif-control-type"]);
    }
  });

  it("P, Q, R, S, N, W take a letter only", () => {
    for (const l of ["P", "Q", "R", "S", "N", "W"]) {
      const ok = validateNif(makeCif(l, "7654321", "letter"));
      expect([l, ok.valid, ok.type]).toEqual([l, true, "cif"]);
      const wrong = validateNif(makeCif(l, "7654321", "digit"));
      expect([l, wrong.valid, wrong.error]).toEqual([l, false, "cif-control-type"]);
    }
  });

  it("C, D, F, G, J, U, V take either a letter or a digit", () => {
    for (const l of ["C", "D", "F", "G", "J", "U", "V"]) {
      for (const form of ["digit", "letter"] as const) {
        const r = validateNif(makeCif(l, "5810040", form));
        expect([l, form, r.valid, r.type]).toEqual([l, form, true, "cif"]);
      }
    }
  });

  it("a control of zero is 0 as a digit and J as a letter", () => {
    // 0000000 sums to 0 → control 0 / J.
    expect(cifControl("0000000")).toEqual({ digit: "0", letter: "J" });
    expect(validateNif("G00000000").valid).toBe(true);
    expect(validateNif("G0000000J").valid).toBe(true);
    expect(validateNif("A0000000J").error).toBe("cif-control-type");
    expect(validateNif("Q00000000").error).toBe("cif-control-type");
  });

  it("rejects a CIF whose control character doesn't match the checksum", () => {
    const validCif = makeCif("A", "1234567");
    const tampered = validCif.slice(0, 8) + (validCif[8] === "0" ? "1" : "0");
    const r = validateNif(tampered);
    expect(r.valid).toBe(false);
    expect(r.error).toBe("cif-checksum");
    // Either form must still be the right one.
    expect(validateNif("G1234567E").error).toBe("cif-checksum");
    expect(validateNif("G12345675").error).toBe("cif-checksum");
    expect(validateNif("S1234567E").error).toBe("cif-checksum");
  });

  it("does not take a letter whose position matches the digit (no cross-form leniency)", () => {
    // Control 4 → D. "E" is index 5 of JABCDEFGHI; neither 4 nor D.
    expect(validateNif("C1234567E").valid).toBe(false);
  });

  // ---------- end CIF ----------

  it("rejects C-shaped letters that are not in the CIF alphabet (I, O, Ñ, U, P-aware subset)", () => {
    expect(validateNif("I12345678").valid).toBe(false);
  });

  it("rejects empty input", () => {
    expect(validateNif("").valid).toBe(false);
    expect(validateNif("   ").valid).toBe(false);
  });

  it("rejects wrong length", () => {
    expect(validateNif("123").valid).toBe(false);
    expect(validateNif("1234567890").valid).toBe(false);
  });

  it("rejects garbage characters", () => {
    const r = validateNif("$%$%");
    expect(r.valid).toBe(false);
  });
});
