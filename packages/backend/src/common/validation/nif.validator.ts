/**
 * Spanish tax identifier (NIF / CIF / NIE) format validation.
 *
 * Sources:
 *  - NIF: 8 digits + 1 letter  (DNI/NIF for Spanish residents)
 *    Letter is the modulo-23 of the number itself.
 *  - NIE: X/Y/Z + 7 digits + 1 letter (foreign residents)
 *    Substituted: X→0, Y→1, Z→2 then treated as NIF.
 *  - CIF: letter + 7 digits + letter/digit (legal entities)
 *    Control character is computed from a weighted-sum checksum.
 *    Whether it is a letter, a digit or either depends on the
 *    starting letter (see CIF_CONTROL_TYPE).
 *
 * Returns { valid, type?, normalized?, error? }.
 */

const NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";

// Starting letter → which control characters it takes (Orden EHA/451/2008;
// the AEAT's "Ayuda NIF"):
//   P, Q, R, S, N, W    → letter only (public bodies, non-resident entities)
//   A, B, E, H          → digit only (S.A., S.L., comunidades de bienes / de propietarios)
//   C, D, F, G, J, U, V → letter or digit
// C, D, F, G, J, U and V used to be "letter only", which refused the many
// asociaciones (G), cooperativas (F) and sociedades civiles (J) whose CIF
// ends in a digit.
const CIF_CONTROL_TYPE: Record<string, "digit" | "letter" | "both"> = {
  A: "digit",
  B: "digit",
  E: "digit",
  H: "digit",
  P: "letter",
  Q: "letter",
  R: "letter",
  S: "letter",
  N: "letter",
  W: "letter",
  C: "both",
  D: "both",
  F: "both",
  G: "both",
  J: "both",
  U: "both",
  V: "both",
};

const CIF_CONTROL_LETTERS = "JABCDEFGHI";

export interface NifValidation {
  valid: boolean;
  type?: "nif" | "cif" | "nie";
  /** Normalized: trimmed, uppercase, no dashes. */
  normalized?: string;
  /** Human-readable error when `valid` is false. */
  error?: string;
}

function normalize(input: string): string {
  return input.replace(/[\s.\-]/g, "").toUpperCase();
}

function computeNifLetter(number: number): string {
  return NIF_LETTERS[number % 23];
}

/**
 * The CIF checksum as a digit 0-9.
 *
 *   1. Each of the 7 middle digits at position p (0-indexed) is weighted:
 *      even p → 2, odd p → 1.
 *   2. A two-digit product (≥ 10) counts as the sum of its digits.
 *   3. Sum them all.
 *   4. The control digit is `(10 - sum mod 10) mod 10`; as a letter it is
 *      CIF_CONTROL_LETTERS[digit] (J for 0, A for 1 ... I for 9).
 */
function computeCifControlDigit(body: string): number {
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const digit = parseInt(body[i], 10);
    const weight = i % 2 === 0 ? 2 : 1; // even pos (0,2,4,6) → weight 2
    const product = digit * weight;
    sum += product < 10 ? product : Math.floor(product / 10) + (product % 10);
  }
  return (10 - (sum % 10)) % 10;
}

export function validateNif(raw: string): NifValidation {
  if (!raw || typeof raw !== "string") {
    return { valid: false, error: "empty" };
  }
  const s = normalize(raw);
  if (!s || s.length < 8 || s.length > 9) {
    return { valid: false, error: "length" };
  }

  // NIE: X/Y/Z + 7 digits + letter
  if (/^[XYZ]\d{7}[A-Z]$/.test(s)) {
    const map: Record<string, string> = { X: "0", Y: "1", Z: "2" };
    const numeric = map[s[0]] + s.slice(1, 8);
    const letter = computeNifLetter(parseInt(numeric, 10));
    if (letter !== s[8]) {
      return { valid: false, error: "nie-checksum" };
    }
    return { valid: true, type: "nie", normalized: s };
  }

  // NIF: 8 digits + 1 letter
  if (/^\d{8}[A-Z]$/.test(s)) {
    const letter = computeNifLetter(parseInt(s.slice(0, 8), 10));
    if (letter !== s[8]) {
      return { valid: false, error: "nif-checksum" };
    }
    return { valid: true, type: "nif", normalized: s };
  }

  // CIF: 1 letter + 7 digits + 1 letter-or-digit
  if (/^[A-HJNP-SUVW]\d{7}[0-9A-J]$/.test(s)) {
    const allowed = CIF_CONTROL_TYPE[s[0]];
    const provided = s[8];
    const providedIsDigit = /\d/.test(provided);
    // A letter where the starting letter takes only a digit, or the other
    // way round.
    if ((allowed === "digit" && !providedIsDigit) || (allowed === "letter" && providedIsDigit)) {
      return { valid: false, error: "cif-control-type" };
    }
    const control = computeCifControlDigit(s.slice(1, 8));
    const expected = providedIsDigit ? String(control) : CIF_CONTROL_LETTERS[control];
    if (provided !== expected) {
      return { valid: false, error: "cif-checksum" };
    }
    return { valid: true, type: "cif", normalized: s };
  }

  return { valid: false, error: "format" };
}
