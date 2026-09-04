/**
 * Spanish tax identifier (NIF / CIF / NIE) format validation.
 *
 * Sources:
 *  - NIF: 8 digits + 1 letter  (DNI/NIF for Spanish residents)
 *    Letter is the modulo-23 of the number itself.
 *  - NIE: X/Y/Z + 7 digits + 1 letter (foreign residents)
 *    Substituted: X→0, Y→1, Z→2 then treated as NIF.
 *  - CIF: letter + 7 digits + letter/digit (legal entities)
 *    Control character is computed from a weighted-sum checksum
 *    per Real Decreto 338/1990. The control character is either a
 *    letter or a digit; the choice depends on the type of the
 *    starting letter.
 *
 * Returns { valid, type?, normalized?, error? }.
 */

const NIF_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE";

// Per RD 338/1990: starting letter → set of allowed control characters.
// Reference: https://www2.agenciatributaria.gob.es/static_files/common/internet/dep/aplicaciones/es/aeat/ort/info_general/modelos/AyudaNIF.pdf
//   A, B, E, H → digit only
//   K, P, Q, S, N, W → letter or digit
//   All others → letter only
const CIF_CONTROL_TYPE: Record<string, "digit" | "letter" | "both"> = {
  A: "digit",
  B: "digit",
  E: "digit",
  H: "digit",
  K: "letter",
  P: "letter",
  Q: "letter",
  S: "letter",
  N: "letter",
  W: "letter",
  C: "letter",
  D: "letter",
  F: "letter",
  G: "letter",
  J: "letter",
  R: "letter",
  U: "letter",
  V: "letter",
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
 * Compute the CIF checksum control character.
 *
 * Algorithm (RD 338/1990):
 *   1. For each of the 7 middle digits at position p (0-indexed), the
 *      position-weight is: even p → 2, odd p → 1.
 *   2. Multiply the digit by the weight; if the result is two-digit
 *      (i.e. ≥ 10) sum its digits.
 *   3. Sum all weighted values.
 *   4. Round the sum up to the next multiple of 10.
 *   5. The control character is `10 - (sum mod 10) mod 10` as a digit.
 *      If the starting letter's table entry allows letters, convert to
 *      letter via CIF_CONTROL_LETTERS[digit].
 */
function computeCifControl(letter: string, body: string): string {
  let sum = 0;
  for (let i = 0; i < 7; i++) {
    const digit = parseInt(body[i], 10);
    const weight = i % 2 === 0 ? 2 : 1; // even pos (0,2,4,6) → weight 2
    const product = digit * weight;
    sum += product < 10 ? product : Math.floor(product / 10) + (product % 10);
  }
  const rounded = Math.ceil(sum / 10) * 10;
  const controlDigit = (10 - (rounded % 10)) % 10;
  const allowed = CIF_CONTROL_TYPE[letter] ?? "letter";
  if (allowed === "digit") {
    return String(controlDigit);
  }
  return CIF_CONTROL_LETTERS[controlDigit];
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
    const startLetter = s[0];
    const body = s.slice(1, 8);
    const providedControl = s[8];
    const expectedControl = computeCifControl(startLetter, body);

    // Some CIFs use a digit where the table says letter (and vice versa)
    // because the AEAT pre-validates on data entry. Be lenient: accept if
    // either the letter or the digit matches the table for the starting
    // letter. The strict check is only for the *expected* control type.
    const allowed = CIF_CONTROL_TYPE[startLetter] ?? "letter";
    const isDigit = /\d/.test(providedControl);
    const isLetter = /[A-Z]/.test(providedControl);

    // Reject if the provided control character is of the wrong type.
    if (allowed === "digit" && isLetter) {
      return { valid: false, error: "cif-control-type" };
    }
    if (allowed === "letter" && isDigit) {
      return { valid: false, error: "cif-control-type" };
    }
    // Now verify the actual value.
    if (providedControl !== expectedControl) {
      // Letter vs digit: try the alternative representation.
      const altDigit = String(
        CIF_CONTROL_LETTERS.indexOf(providedControl),
      );
      if (altDigit !== expectedControl) {
        return { valid: false, error: "cif-checksum" };
      }
    }
    return { valid: true, type: "cif", normalized: s };
  }

  return { valid: false, error: "format" };
}
