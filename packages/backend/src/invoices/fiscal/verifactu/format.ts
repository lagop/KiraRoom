/**
 * Value formats of the VERI*FACTU records (AEAT "Diseño de registro" and
 * web-service description §6.7-6.9).
 *
 * The fingerprint is computed over the very strings the XML carries, so
 * every value goes through these functions once and the result is used for
 * both. AEAT tolerates "12.3" or "12.30" when it checks, but a record hashed
 * with one and sent with the other does not match its own fingerprint.
 */

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

/** "dd-mm-yyyy": the date the salon's calendar shows at `instant`. */
export function salonDate(instant: Date, timeZone: string): string {
  const { y, mo, d } = wallClock(instant, timeZone);
  return `${d}-${mo}-${y}`;
}

/** The salon-calendar year at `instant` (invoice numbering restarts with it). */
export function salonYear(instant: Date, timeZone: string): number {
  return Number(wallClock(instant, timeZone).y);
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
