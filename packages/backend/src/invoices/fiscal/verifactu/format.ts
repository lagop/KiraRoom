/**
 * Value formats of the VERI*FACTU records (AEAT "Diseño de registro" and
 * web-service description §6.7-6.9).
 *
 * The fingerprint is computed over the very strings the XML carries, so
 * every value goes through these functions once and the result is used for
 * both. AEAT tolerates "12.3" or "12.30" when it checks, but a record hashed
 * with one and sent with the other does not match its own fingerprint.
 */
import { validateNif } from "../../../common/validation/nif.validator";
import type { ForeignId } from "./xml";

/** Cents -> "12.35", "-0.50", "0.00": always two decimals, no leading zeros. */
export function amount(cents: number): string {
  if (!Number.isInteger(cents)) throw new Error(`Amount in cents must be an integer: ${cents}`);
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, "0")}`;
}

/** A tax rate as the XSD Tipo2.2 wants it: "21", "9.5", "7.5", "0". */
export function rate(value: number): string {
  const rounded = Math.round(value * 100) / 100;
  if (rounded < 0 || rounded >= 1000) throw new Error(`Tax rate out of range: ${value}`);
  return String(rounded);
}

/** The wall-clock parts of `instant` in `timeZone`, plus its UTC offset in minutes. */
function wallClock(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const [y, mo, d, h, mi, s] = ["year", "month", "day", "hour", "minute", "second"].map(get);
  const asUtc = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  const offsetMinutes = Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60_000);
  return { y, mo, d, h, mi, s, offsetMinutes };
}

/**
 * FechaHoraHusoGenRegistro: "YYYY-MM-DDThh:mm:ss+hh:mm" in the time zone
 * where the invoice is issued (Orden HAC/1177/2024 art. 7.e). Exactly 25
 * characters: AEAT checks the length (error 1268).
 */
export function generatedAt(instant: Date, timeZone: string): string {
  const { y, mo, d, h, mi, s, offsetMinutes } = wallClock(instant, timeZone);
  const sign = offsetMinutes < 0 ? "-" : "+";
  const abs = Math.abs(offsetMinutes);
  const offset = `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${y}-${mo}-${d}T${h}:${mi}:${s}${offset}`;
}

/** XML text escaping (web-service description §6.9). */
export function xmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * A Spanish NIF/NIE/CIF as AEAT wants it: 9 characters, upper case, no
 * spaces, dashes or dots. Returns null when it cannot be one.
 */
export function nif(value: string | null | undefined): string | null {
  if (!value) return null;
  const clean = value.toUpperCase().replace(/[\s.\-]/g, "");
  // An "ES" VAT prefix is not part of the NIF.
  const bare = clean.length === 11 && clean.startsWith("ES") ? clean.slice(2) : clean;
  return /^[0-9A-Z]{9}$/.test(bare) ? bare : null;
}

/** The shapes of a Spanish NIF, NIE and CIF: whatever has one is checked as one. */
const SPANISH_ID_SHAPE = /^(\d{8}[A-Z]|[XYZ]\d{7}[A-Z]|[A-HJNP-SUVW]\d{7}[0-9A-J])$/;

/**
 * What follows the prefix of a VAT number of each EU country (VIES formats).
 * Precise on purpose: a passport like "PT123456" must not pass as a VAT
 * number. Greece's prefix is EL, its country code GR; GR is accepted too.
 */
const EU_VAT: Record<string, { country: string; format: RegExp }> = {
  AT: { country: "AT", format: /^U\d{8}$/ },
  BE: { country: "BE", format: /^[01]\d{9}$/ },
  BG: { country: "BG", format: /^\d{9,10}$/ },
  CY: { country: "CY", format: /^\d{8}[A-Z]$/ },
  CZ: { country: "CZ", format: /^\d{8,10}$/ },
  DE: { country: "DE", format: /^\d{9}$/ },
  DK: { country: "DK", format: /^\d{8}$/ },
  EE: { country: "EE", format: /^\d{9}$/ },
  EL: { country: "GR", format: /^\d{9}$/ },
  GR: { country: "GR", format: /^\d{9}$/ },
  FI: { country: "FI", format: /^\d{8}$/ },
  FR: { country: "FR", format: /^[0-9A-Z]{2}\d{9}$/ },
  HR: { country: "HR", format: /^\d{11}$/ },
  HU: { country: "HU", format: /^\d{8}$/ },
  IE: { country: "IE", format: /^\d[0-9A-Z]\d{5}[A-Z]{1,2}$/ },
  IT: { country: "IT", format: /^\d{11}$/ },
  LT: { country: "LT", format: /^(\d{9}|\d{12})$/ },
  LU: { country: "LU", format: /^\d{8}$/ },
  LV: { country: "LV", format: /^\d{11}$/ },
  MT: { country: "MT", format: /^\d{8}$/ },
  NL: { country: "NL", format: /^\d{9}B\d{2}$/ },
  PL: { country: "PL", format: /^\d{10}$/ },
  PT: { country: "PT", format: /^\d{9}$/ },
  RO: { country: "RO", format: /^\d{2,10}$/ },
  SE: { country: "SE", format: /^\d{12}$/ },
  SI: { country: "SI", format: /^\d{8}$/ },
  SK: { country: "SK", format: /^\d{10}$/ },
};

export type RecipientId =
  /** Nothing given. */
  | { kind: "none" }
  /** A valid Spanish NIF, NIE or CIF. */
  | { kind: "nif"; nif: string }
  /** A VAT number of another EU country: IDOtro, IDType 02. */
  | { kind: "vat"; otro: ForeignId }
  /** Written like a Spanish NIF, but its control character is wrong. */
  | { kind: "invalid" }
  /**
   * Anything else: a passport, a foreign document. There is no country for
   * it in the data, so it cannot go as IDOtro, and it never goes as a NIF.
   */
  | { kind: "foreign" };

/** What the invoice's tax identifier is, as far as the AEAT is concerned. */
export function recipientId(value: string | null | undefined): RecipientId {
  const clean = (value ?? "").toUpperCase().replace(/[\s.\-]/g, "");
  if (!clean) return { kind: "none" };
  const bare = clean.length === 11 && clean.startsWith("ES") ? clean.slice(2) : clean;
  if (SPANISH_ID_SHAPE.test(bare)) {
    const check = validateNif(bare);
    return check.valid && check.normalized ? { kind: "nif", nif: check.normalized } : { kind: "invalid" };
  }
  const vat = EU_VAT[clean.slice(0, 2)];
  if (vat?.format.test(clean.slice(2))) {
    // The number as VIES has it, with Greece's own prefix.
    const id = clean.startsWith("GR") ? `EL${clean.slice(2)}` : clean;
    return { kind: "vat", otro: { country: vat.country, idType: "02", id } };
  }
  return { kind: "foreign" };
}

/**
 * NumSerieFactura: 1-60 printable ASCII characters, none of " ' < > =
 * (validations §3.1.3.1, error 1130). Throws rather than send a number AEAT
 * will reject.
 */
export function invoiceNumber(series: string, number: string): string {
  const value = `${series}${number}`.trim();
  if (value.length < 1 || value.length > 60 || !/^[\x20-\x7E]+$/.test(value) || /["'<>=]/.test(value)) {
    throw new Error(`Número de factura no válido para Verifactu: "${value}"`);
  }
  return value;
}

/** Text fields: trimmed (AEAT trims them) and cut to the field's maximum. */
export function text(value: string, max: number): string {
  return value.replace(/\s+/g, " ").trim().slice(0, max).trim();
}
