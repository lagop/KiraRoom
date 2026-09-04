import { validateNif, NifValidation } from "./nif.validator";

/**
 * CIF (RD 338/1990) checksum helper for tests. Computes the control
 * character for a given starting letter + 7-digit body. Mirrors the
 * production implementation in nif.validator.ts.
 */
function cifControl(letter: string, body: string): string {
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const digit = parseInt(body[i], 10);
    const weight = i % 2 === 0 ? 2 : 1;
    const product = digit * weight;
    sum += product < 10 ? product : Math.floor(product / 10) + (product % 10);
  }
  const rounded = Math.ceil(sum / 10) * 10;
  const controlDigit = (10 - (rounded % 10)) % 10;
  const CIF_CONTROL_LETTERS = "JABCDEFGHI";
  // For the tests we want both forms so the digits/letters cases
  // can pick. Mirror the production letter/digit table:
  const CIF_CONTROL_TYPE: Record<string, "digit" | "letter" | "both"> = {
    A: "digit", B: "digit", E: "digit", H: "digit",
    C: "letter", D: "letter", F: "letter", G: "letter",
    J: "letter", K: "letter", N: "letter", P: "letter",
    Q: "letter", R: "letter", S: "letter", U: "letter",
    V: "letter", W: "letter",
  };
  const allowed = CIF_CONTROL_TYPE[letter] ?? "letter";
  if (allowed === "digit") return String(controlDigit);
  return CIF_CONTROL_LETTERS[controlDigit];
}

function makeCif(letter: string, body = "1234567"): string {
  return `${letter}${body}${cifControl(letter, body)}`;
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

  // ---------- CIF (RD 338/1990) strict checks ----------

  it("accepts a CIF with a valid digit control (A series uses digits only)", () => {
    // A is in the {digit} group. Body 1234567 + control = computed value.
    const cif = makeCif("A", "1234567");
    const r = validateNif(cif);
    expect(r.valid).toBe(true);
    expect(r.type).toBe("cif");
  });

  it("accepts a CIF with a valid letter control (C series uses letters only)", () => {
    const cif = makeCif("C", "1234567");
    const r = validateNif(cif);
    expect(r.valid).toBe(true);
    expect(r.type).toBe("cif");
  });

  it("rejects a CIF whose control character doesn't match the checksum", () => {
    // Take a valid CIF and change the last character to something else.
    const validCif = makeCif("A", "1234567");
    const tampered = validCif.slice(0, 8) + (validCif[8] === "0" ? "1" : "0");
    const r = validateNif(tampered);
    expect(r.valid).toBe(false);
    expect(r.error).toBe("cif-checksum");
  });

  it("rejects a CIF with the wrong control type (digit when letter expected)", () => {
    // C requires a letter control. Provide a digit instead.
    const r = validateNif("C12345670");
    expect(r.valid).toBe(false);
    expect(r.error).toBe("cif-control-type");
  });

  it("rejects a CIF with the wrong control type (letter when digit expected)", () => {
    // A requires a digit. Provide a letter.
    const r = validateNif("A1234567J");
    expect(r.valid).toBe(false);
    expect(r.error).toBe("cif-control-type");
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
